// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.28;

// OpenZeppelin
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// Uniswap V4 - Core
import {IPoolManager, ModifyLiquidityParams} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

// Uniswap V4 - Periphery
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {PositionInfoLibrary, PositionInfo} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";

// Local
import {Uni4All} from "./Uni4All.sol";
import {OracleLib} from "./OracleLib.sol";

contract CentralBankERC20 is ERC20 {
    address internal immutable centralBank;

    constructor(
        address centralBankAddress,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) {
        centralBank = centralBankAddress;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == centralBank, "Forbidden");
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}

/// @notice The Central Bank of MONA. Mints and redeems stablecoins, manages system liquidity.
contract CentralBank is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    using SafeERC20 for CentralBankERC20;
    using PositionInfoLibrary for *;
    using OracleLib for *;
    using Uni4All for *;

    enum BurnReason {Redemption, Policy}

    // --------------------
    // External system addresses
    // --------------------

    // Reference implementation uses tBTC as collateral.
    // The protocol is collateral-agnostic; production collateral is intended
    // to be GENIUS-compliant, low-volatility tokenized U.S. T-bills.
    address internal constant DEMO_COLLATERAL_ASSET_ADDRESS = 0x18084fbA666a33d37592fA2633fD49a74DD93a88;
    IPoolManager public constant POOL_MANAGER = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    IPositionManager public constant POSITION_MANAGER = IPositionManager(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e);

    // --------------------
    // Core system assets
    // --------------------

    IERC20 private immutable collateralAsset;
    CentralBankERC20 public immutable bankShare;
    CentralBankERC20 public immutable stablecoin;
    CentralBankERC20 public immutable memecoin;

    // --------------------
    // System parameters
    // --------------------

    uint256 public constant DECIMALS = 1e18;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // Total number of bank shares minted to seed the liquidity pool.
    // These are the only bank shares that will ever be minted.
    uint256 public constant TOTAL_SHARE_SUPPLY = 100000 * DECIMALS;

    // reward given to the caller of harvestFees() -- caller will receive
    // callerRewardBps of the yield harvested from the liquidity pool.
    // this is so that the protocol doesn't need a keeper bot in order
    // to harvest fees -- the general public is incentivized to call harvestFees().
    uint256 public constant MAX_CALLER_REWARD_BPS = 1000;
    // invariant: callerRewardBps <= MAX_CALLER_REWARD_BPS
    uint256 public callerRewardBps = 50;

    // when the protocol is above targetCollateralRatioBps, stablecoin
    // will be minted and distributed to bankShare stakers. The amount of
    // stablecoin minted will be the amount necessary to bring the protocol
    // back down to targetCollateralRatioBps.
    // The protocol enforces a MIN_TARGET_COLLATERAL_RATIO_BPS (here
    // set to 99%) so that the protocol operator cannot ever lower
    // targetCollateralRatioBps to an unsafe value (e.g. 50%).
    uint256 public constant MIN_TARGET_COLLATERAL_RATIO_BPS = 9900;
    // invariant: targetCollateralRatioBps >= MIN_TARGET_COLLATERAL_RATIO_BPS
    uint256 public targetCollateralRatioBps = 15000;

    // the protocol burns stablecoinBurnRatioBps of yield generated from
    // protocol-owned liquidity, in order to improve collateral ratio.
    // this value can be adjusted via setter function by protocol owner.
    // invariant: stablecoinBurnRatioBps <= BPS_DENOMINATOR
    uint256 public stablecoinBurnRatioBps = 5000;

    uint256 public memecoinMultiplier = 1000;

    // minting and burning need to charge a small fee to discourage oracle lag arbitrage.
    // the operator of the protocol can adjust these freely up to the MAX_MINT_FEE (set
    // here to 1%). If oracle lag arbitrage becomes a problem, increase mint/redemption
    // fees until the arbitrage becomes unprofitable.
    uint256 public constant MAX_MINT_FEE_BPS = 100;
    // invariant: mintFeeBps <= MAX_MINT_FEE_BPS
    uint256 public mintFeeBps = 5;
    uint256 public constant MAX_REDEMPTION_FEE_BPS = 100;
    // invariant: redemptionFeeBps <= MAX_REDEMPTION_FEE_BPS
    uint256 public redemptionFeeBps = 5;

    // Uniswap Liquidity position parameters
    // Liquidity position maintains a +- 50% range around current spot price
    // Repositions to current spot price when liquidity center is more than 10% away from spot price
    // Tick range around current tick (approx +- 50% in price for tickSpacing=60)
    int24 public constant TICK_RANGE = 4080;
    // Rebalance when current tick drifts this far from position center (approx 10%)
    int24 public constant REBALANCE_THRESHOLD = 960;

    uint24 public constant UNISWAP_POOL_FEE = 3000;
    int24 public constant UNISWAP_TICK_SPACING = 60;

    // --------------------
    // System state
    // --------------------

    uint256 public lastHarvested = 0;
    uint256 public totalHarvested = 0;
    uint256 public totalRealizedHarvest = 0;
    uint256 public stablecoinBurnedFromRedemption = 0;
    uint256 public stablecoinBurnedByPolicy = 0;

    // --------------------
    // Liquidity pool state
    // --------------------

    uint256 public tokenId = 0; // tokenId of current liquidity position
    bool private poolInitialized = false;
    PoolKey public poolKey;

    // --------------------
    // Staking vault
    // --------------------

    StakingVault public immutable stakingVault;

    // --------------------
    // Events
    // --------------------

    event LiquidityPoolInitialized();
    event StablecoinMinted(address indexed user, uint256 collateralDeposited, uint256 stablesMinted);
    event StablecoinRedeemed(address indexed user, uint256 stablesBurned, uint256 collateralReturned);
    event StablecoinBurned(uint256 amount, BurnReason reason);
    event LiquidityRewardsCollected(
        address indexed caller,
        uint256 stablecoinHarvestedFromPool,
        uint256 stablecoinMintedForStakers,
        uint256 stablecoinDistributedToStakers,
        uint256 stablecoinBurned,
        uint256 stablecoinDistributedToCaller
    );
    event TargetCollateralRatioUpdated(address indexed caller, uint256 oldRatioBps, uint256 newRatioBps);
    event StablecoinBurnRatioUpdated(address indexed caller, uint256 oldRatioBps, uint256 newRatioBps);
    event MemecoinMultiplierUpdated(address indexed caller, uint256 oldMultiplier, uint256 newMultiplier);
    event MintFeeUpdated(address indexed caller, uint256 oldFeeBps, uint256 newFeeBps);
    event RedemptionFeeUpdated(address indexed caller, uint256 oldFeeBps, uint256 newFeeBps);
    event CallerRewardUpdated(address indexed caller, uint256 oldRewardBps, uint256 newRewardBps);
    event Donation(
        address indexed donor,
        uint256 donationAmount,
        uint256 stablecoinBurned,
        uint256 stablecoinDistributed,
        uint256 memecoinMinted
    );

    // --------------------
    // Protocol initialization
    // --------------------

    constructor() Ownable(msg.sender) {
        collateralAsset = IERC20(DEMO_COLLATERAL_ASSET_ADDRESS);
        stablecoin = new CentralBankERC20(address(this), "MONA", "MONA");
        bankShare = new CentralBankERC20(address(this), "LISA", "LISA");
        memecoin = new CentralBankERC20(address(this), "MEME", "MEME");
        stakingVault = new StakingVault(address(this), stablecoin, bankShare);

        // These are the only bank shares that will ever be minted.
        bankShare.mint(address(this), TOTAL_SHARE_SUPPLY);
        stablecoin.mint(address(this), TOTAL_SHARE_SUPPLY);

        approveAll();
    }

    function approveAll() public {
        Uni4All.approveRouter(address(bankShare));
        Uni4All.approveRouter(address(stablecoin));

        Uni4All.approvePositionManager(address(bankShare));
        Uni4All.approvePositionManager(address(stablecoin));

        stablecoin.approve(address(stakingVault), type(uint256).max);
    }

    function initializeLiquidityPool(address poolHooks) public {
        require(!poolInitialized, "Pool already initialized");

        poolKey = Uni4All.initializePool(
            stablecoin,
            bankShare,
            UNISWAP_POOL_FEE,
            UNISWAP_TICK_SPACING,
            poolHooks,
            uint160(1) << 96 // starting price; 1:1 pool -> starting price is $1
        );

        tokenId = Uni4All.addLiquidity(
            poolKey,
            uint128(IERC20(Currency.unwrap(poolKey.currency0)).balanceOf(address(this))),
            uint128(IERC20(Currency.unwrap(poolKey.currency1)).balanceOf(address(this))),
            -TICK_RANGE,
            TICK_RANGE
        );

        poolInitialized = true;
        emit LiquidityPoolInitialized();
    }

    // --------------------
    // Mint / Redeem
    // --------------------

    function mintStablecoin(
        uint256 amountToMint,
        uint256 maxAmountIn,
        uint256 deadline
    )
        external
        nonReentrant
        returns (uint256) 
    {
        require(amountToMint > 0, "Amount must be > 0");
        require(block.timestamp <= deadline, "Expired");

        // round up
        uint256 amountToDeposit = Math.mulDiv(amountToMint, DECIMALS, getPrice(), Math.Rounding.Ceil);
        require(amountToDeposit <= maxAmountIn, "Oracle/slippage");

        // pull exactly that much collateral
        collateralAsset.safeTransferFrom(msg.sender, address(this), amountToDeposit);

        // apply minting fee
        amountToMint = Math.mulDiv(amountToMint, BPS_DENOMINATOR - mintFeeBps, BPS_DENOMINATOR);
        stablecoin.mint(msg.sender, amountToMint);

        emit StablecoinMinted(msg.sender, amountToDeposit, amountToMint);
        return amountToMint;
    }

    function redeemStablecoin(
        uint256 amountToRedeem,
        uint256 minAmountOut,
        uint256 deadline
    ) 
        external
        nonReentrant
        returns (uint256) 
    {
        require(amountToRedeem > 0, "Amount must be > 0");
        require(block.timestamp <= deadline, "Expired");

        // Round down
        uint256 withdrawalAmount = Math.mulDiv(amountToRedeem, DECIMALS, getPrice(), Math.Rounding.Floor);

        // apply redemption fee
        withdrawalAmount = Math.mulDiv(withdrawalAmount, BPS_DENOMINATOR - redemptionFeeBps, BPS_DENOMINATOR);
        require(withdrawalAmount >= minAmountOut, "Oracle/slippage");

        stablecoin.safeTransferFrom(msg.sender, address(this), amountToRedeem);

        _burnStablecoin(amountToRedeem, BurnReason.Redemption);

        collateralAsset.safeTransfer(msg.sender, withdrawalAmount);

        emit StablecoinRedeemed(msg.sender, amountToRedeem, withdrawalAmount);
        return withdrawalAmount;
    }

    // --------------------
    // Rewards / Policy
    // --------------------

    function harvestFees() external nonReentrant {
        uint256 stablecoinBalanceBeforeHarvest = stablecoin.balanceOf(address(this));

        Uni4All.collectFeesFromLiquidityPool(stablecoin, bankShare, tokenId);

        uint256 bankShareBalance = bankShare.balanceOf(address(this));
        if (bankShareBalance > 0) {
            // We have two choices here:
            //   1) burn harvested bankShare
            //     --makes bankShare deflationary
            //       -> upward pressure on bankShare price
            //     --liquidity pool gets thin over time as bankShare is burned
            //       -> less arbitrage -> less yield to stakers
            //   2) sell harvested bankShare back into pool for stablecoin
            //     --bankShare supply remains stable
            //     --increases yield paid to stakers (via direct distribution of stablecoin
            //       or by burning the stablecoin to improve collateral ratio)
            //     --liquidity pool stays stronger over time (bankShare not burned)
            //       -> more arbitrage -> more yield to stakers
            // Either choice is defensible. We've chosen option 2 here.
            Uni4All.swapTokens(address(bankShare), address(stablecoin), uint128(bankShareBalance), poolKey);
        }
        uint256 stablecoinBalanceAfterHarvest = stablecoin.balanceOf(address(this));
        // stablecoinBalanceAfterHarvest should always be greater than stablecoinBalanceBeforeHarvest
        require(stablecoinBalanceAfterHarvest >= stablecoinBalanceBeforeHarvest, "Harvest decreased balance");

        // If the pool needs rebalancing, calling harvestFees() forces a rebalance.
        if (poolNeedsRebalancing()) {
            tokenId = Uni4All.rebalanceLiquidityPosition(
                stablecoin,
                bankShare,
                tokenId,
                poolKey,
                UNISWAP_TICK_SPACING,
                TICK_RANGE
            );
        }

        uint256 burnRatioToApplyBps = stablecoinBurnRatioBps;
        uint256 maxBurnRatioBps = BPS_DENOMINATOR - callerRewardBps; // burn must leave room for caller
        if (burnRatioToApplyBps > maxBurnRatioBps) {
            burnRatioToApplyBps = maxBurnRatioBps;
        }

        uint256 stablecoinHarvested = stablecoinBalanceAfterHarvest - stablecoinBalanceBeforeHarvest;
        uint256 callerReward = Math.mulDiv(stablecoinHarvested, callerRewardBps, BPS_DENOMINATOR);
        uint256 amountToBurn = Math.mulDiv(stablecoinHarvested, burnRatioToApplyBps, BPS_DENOMINATOR);
        uint256 amountToDistribute = stablecoinHarvested - callerReward - amountToBurn;
        // amountToBurn = stablecoinHarvested - callerReward - amountToDistribute

        // check if the protocol is overcollateralized above targetCollateralRatioBps.
        // if it is, mint stablecoin to bring the collateral ratio down to targetCollateralRatioBps,
        // and distribute to stakers.
        // Note that we don't apply stablecoinBurnRatio here, because the intent is to
        // bring collateral ratio down to exactly targetCollateralRatioBps, and distribute
        // the newly minted stablecoin to stakers. Burning some would make no sense.
        uint256 stablecoinSupply = redeemableStablecoinSupply();
        uint256 supplyAtTargetRatio = Math.mulDiv(valueOfCollateral(), BPS_DENOMINATOR, targetCollateralRatioBps);
        uint256 amountToMint = 0;
        if (supplyAtTargetRatio > stablecoinSupply) {
            amountToMint = supplyAtTargetRatio - stablecoinSupply;
            amountToDistribute += amountToMint;
        }

        // if nothing is staked, there's nothing to do with harvested stablecoin except burn it.
        if (amountToDistribute > 0 && stakingVault.totalStaked() == 0) {
            amountToBurn += amountToDistribute;
            amountToDistribute = 0;
        }

        if (amountToMint > 0) {
            stablecoin.mint(address(this), amountToMint);
        }
        if (amountToDistribute > 0) {
            stakingVault.deposit(amountToDistribute);
        }
        if (callerReward > 0) {
            stablecoin.safeTransfer(msg.sender, callerReward);
        }
        if (amountToBurn > 0) {
            _burnStablecoin(amountToBurn, BurnReason.Policy);
        }

        lastHarvested = block.timestamp;
        totalHarvested += stablecoinHarvested;
        totalRealizedHarvest += stablecoinHarvested - amountToBurn;
        emit LiquidityRewardsCollected(
            msg.sender,
            stablecoinHarvested,
            amountToMint,
            amountToDistribute,
            amountToBurn,
            callerReward
        );
    }

    /**
     * @notice Donate stablecoin to protocol stakers.
     * @dev Intended primarily for protocol-controlled revenue sources (e.g. frontend
     *      fees, vault management fees, or other protocol income). Donated funds are
     *      partially burned according to policy and the remainder distributed to stakers.
     */
    function donate(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be > 0");

        stablecoin.safeTransferFrom(msg.sender, address(this), amount);

        // if nothing is staked, burn the whole donation.
        // otherwise, burn by stablecoinBurnRatioBps
        uint256 amountToBurn = amount;
        if (stakingVault.totalStaked() > 0) {
            amountToBurn = Math.mulDiv(amount, stablecoinBurnRatioBps, BPS_DENOMINATOR);
        }
        uint256 amountToDeposit = amount - amountToBurn;

        if (amountToBurn > 0) {
            _burnStablecoin(amountToBurn, BurnReason.Policy);
        }
        if (amountToDeposit > 0) {
            stakingVault.deposit(amountToDeposit);
        }

        // mint a comically large amount of memecoins to reward the donor with.
        uint256 memecoinsMinted = amount * memecoinMultiplier;
        memecoin.mint(msg.sender, memecoinsMinted);

        emit Donation(msg.sender, amount, amountToBurn, amountToDeposit, memecoinsMinted);
    }

    function _burnStablecoin(uint256 amount, BurnReason reason) internal {
        if (amount == 0) return;
        if (reason == BurnReason.Redemption) {
            stablecoinBurnedFromRedemption += amount;
        } else if (reason == BurnReason.Policy) {
            stablecoinBurnedByPolicy += amount;
        }
        stablecoin.burn(amount);
        emit StablecoinBurned(amount, reason);
    }

    // --------------------
    // Views
    // --------------------

    function getPrice() public view returns (uint256) {
        return OracleLib.getLatestPrice();
    }

    function poolNeedsRebalancing() public view returns (bool) {
        (, int24 currentPoolTick, ,) = StateLibrary.getSlot0(POOL_MANAGER, poolKey.toId());
        int256 widerPoolTick = int256(currentPoolTick);
        (, PositionInfo info) = POSITION_MANAGER.getPoolAndPositionInfo(tokenId);
        int24 positionTickLower = PositionInfoLibrary.tickLower(info);
        int24 positionTickUpper = PositionInfoLibrary.tickUpper(info); 
        // positionTickLower and positionTickUpper are guaranteed to be multiples
        // of 60 since 60 is the tick spacing of the pool, so their addition must be
        // divisible by 2.
        int256 positionCenterTick = (int256(positionTickLower) + int256(positionTickUpper)) / 2;
        return abs(widerPoolTick - positionCenterTick) > REBALANCE_THRESHOLD;
    }

    function collateralRatio() public view returns (uint256) {
        uint256 supply = redeemableStablecoinSupply();
        if (supply == 0) return type(uint256).max; // infinite if no supply
        uint256 collateralValue = valueOfCollateral();
        return Math.mulDiv(collateralValue, BPS_DENOMINATOR, supply); // returns in bps
    }

    function valueOfCollateral() public view returns (uint256) {
        return Math.mulDiv(getPrice(), collateralAsset.balanceOf(address(this)), DECIMALS);
    }

    function redeemableStablecoinSupply() public view returns (uint256) {
        // At deployment, TOTAL_SHARE_SUPPLY stablecoin is minted into the liquidity pool.
        // These tokens cannot be redeemed for collateral because they're structurally locked:
        // extracting them requires bankShare tokens, but all bankShare are also in the pool.
        //
        // This deadlock breaks when users deposit collateral and mint NEW stablecoin, which they
        // use to buy bankShare from the pool. Once trading begins, the protocol harvests the initial
        // stablecoins out as LP fees and either distributes them to stakers/callers of harvestFees()
        // or burns them (to improve collateral ratio). Only distributed tokens enter circulation.
        //
        // Redeemable supply = stablecoin that can be redeemed for collateral:
        return stablecoin.totalSupply() - TOTAL_SHARE_SUPPLY + Math.min(TOTAL_SHARE_SUPPLY, totalRealizedHarvest);
        //
        // Breakdown:
        // - Start with total supply (all stablecoin ever minted)
        // - Subtract TOTAL_SHARE_SUPPLY (initial locked amount)
        // - Add back distributed amount (harvested tokens that entered circulation, not burned ones)
        //
        // Eventually converges to totalSupply() once all initial tokens are distributed.
    }

    function getPositionInfo() external view returns (int24 tickLower, int24 tickUpper, uint128 liquidity) {
        (, PositionInfo info) = POSITION_MANAGER.getPoolAndPositionInfo(tokenId);
        tickLower = PositionInfoLibrary.tickLower(info);
        tickUpper = PositionInfoLibrary.tickUpper(info);
        liquidity = POSITION_MANAGER.getPositionLiquidity(tokenId);
    }

    function getPoolInfo() external view returns (int24 currentTick, uint160 sqrtPriceX96) {
        (sqrtPriceX96, currentTick, ,) = StateLibrary.getSlot0(POOL_MANAGER, poolKey.toId());
    }

    // --------------------
    // Setters
    // --------------------

    function setTargetCollateralRatio(uint256 ratio) external onlyOwner {
        require(ratio >= MIN_TARGET_COLLATERAL_RATIO_BPS, "Out of range");
        uint256 oldRatio = targetCollateralRatioBps;
        targetCollateralRatioBps = ratio;
        emit TargetCollateralRatioUpdated(msg.sender, oldRatio, ratio);
    }

    function setStablecoinBurnRatio(uint256 ratio) external onlyOwner {
        require(ratio <= BPS_DENOMINATOR, "Out of range");
        uint256 oldRatio = stablecoinBurnRatioBps;
        stablecoinBurnRatioBps = ratio;
        emit StablecoinBurnRatioUpdated(msg.sender, oldRatio, ratio);
    }

    function setMemecoinMultiplier(uint256 multiplier) external onlyOwner {
        require(multiplier > 0, "Out of range");
        uint256 oldMultiplier = memecoinMultiplier;
        memecoinMultiplier = multiplier;
        emit MemecoinMultiplierUpdated(msg.sender, oldMultiplier, multiplier);
    }

    function setRedemptionFee(uint256 fee) external onlyOwner {
        require(fee <= MAX_REDEMPTION_FEE_BPS, "Out of range");
        uint256 oldFee = redemptionFeeBps;
        redemptionFeeBps = fee;
        emit RedemptionFeeUpdated(msg.sender, oldFee, fee);
    }

    function setMintFee(uint256 fee) external onlyOwner {
        require(fee <= MAX_MINT_FEE_BPS, "Out of range");
        uint256 oldFee = mintFeeBps;
        mintFeeBps = fee;
        emit MintFeeUpdated(msg.sender, oldFee, fee);
    }

    function setCallerReward(uint256 reward) external onlyOwner {
        require(reward <= MAX_CALLER_REWARD_BPS, "Out of range");
        uint256 oldReward = callerRewardBps;
        callerRewardBps = reward;
        emit CallerRewardUpdated(msg.sender, oldReward, reward);
    }

    // --------------------
    // Pure helpers
    // --------------------

    function abs(int256 x) public pure returns (int256) {
        return x >= 0 ? x : -x;
    }
}

contract StakingVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant DECIMALS = 1e18;

    uint256 public totalStaked = 0;
    uint256 public rewardPerShare = 0;

    mapping(address => uint256) public stakeAmount;
    mapping(address => uint256) public rewardDebt;

    IERC20 internal immutable stablecoin;
    IERC20 internal immutable bankShare;

    address internal immutable centralBank;

    event Claimed(address indexed user, uint256 reward);
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Deposited(address indexed from, uint256 amount, uint256 rewardPerShare);

    constructor(address _centralBank, IERC20 _stablecoin, IERC20 _bankShare) {
        centralBank = _centralBank;
        stablecoin = _stablecoin;
        bankShare = _bankShare;
    }

    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        _claim();

        bankShare.safeTransferFrom(msg.sender, address(this), amount);

        stakeAmount[msg.sender] += amount;
        totalStaked += amount;
        rewardDebt[msg.sender] = Math.mulDiv(stakeAmount[msg.sender], rewardPerShare, DECIMALS);

        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        require(amount > 0 && stakeAmount[msg.sender] >= amount, "Invalid unstake");
        _claim();

        stakeAmount[msg.sender] -= amount;
        totalStaked -= amount;
        rewardDebt[msg.sender] = Math.mulDiv(stakeAmount[msg.sender], rewardPerShare, DECIMALS);

        bankShare.safeTransfer(msg.sender, amount);

        emit Unstaked(msg.sender, amount);
    }

    function claim() external nonReentrant {
        _claim();
    }

    function _claim() internal {
        // Rounding in reward calculations can create dust. This amounts to fractions
        // of a penny over decades. Not worth the gas to redistribute.
        uint256 accumulated = Math.mulDiv(stakeAmount[msg.sender], rewardPerShare, DECIMALS);
        uint256 pending = accumulated - rewardDebt[msg.sender];
        if (pending > 0) {
            stablecoin.safeTransfer(msg.sender, pending);
            emit Claimed(msg.sender, pending);
        }
        rewardDebt[msg.sender] = accumulated;
    }

    function deposit(uint256 amount) external nonReentrant {
        require(totalStaked > 0, "Nothing is staked");
        stablecoin.safeTransferFrom(msg.sender, address(this), amount);
        rewardPerShare += Math.mulDiv(amount, DECIMALS, totalStaked);
        emit Deposited(msg.sender, amount, rewardPerShare);
    }

    function pendingRewards(address user) external view returns (uint256) {
        uint256 accumulated = Math.mulDiv(stakeAmount[user], rewardPerShare, DECIMALS);
        if (accumulated < rewardDebt[user]) return 0;
        return accumulated - rewardDebt[user];
    }

    function getUserInfo(address user) external view returns (uint256 staked, uint256 debt, uint256 pending) {
        staked = stakeAmount[user];
        debt = rewardDebt[user];
        uint256 accumulated = (staked * rewardPerShare) / DECIMALS;
        pending = accumulated > debt ? accumulated - debt : 0;
    }
}

contract PoolHooks is BaseHook {
    using StateLibrary for IPoolManager;

    constructor(address _manager) BaseHook(IPoolManager(_manager)) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /**
     * @notice Enforces that only the protocol can provide liquidity to this pool
     * @dev Since Uniswap v4 hooks cannot access the original caller (msg.sender is always
     *      the PoolManager), we enforce exclusivity by requiring liquidity == 0 before adding.
     *      This works because:
     *      1. The protocol atomically initializes the pool and adds the first liquidity position
     *      2. When rebalancing, the protocol removes ALL liquidity and re-adds it in the same transaction
     *      3. No external party can front-run or insert liquidity during these atomic operations
     *      4. Therefore, liquidity will only be zero when the protocol is adding/rebalancing
     */
    function _beforeAddLiquidity(
        address,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) internal view override returns (bytes4) {
        uint128 liquidity = poolManager.getLiquidity(key.toId());
        require(liquidity == 0, "Only protocol can provide liquidity");
        return BaseHook.beforeAddLiquidity.selector;
    }
}
