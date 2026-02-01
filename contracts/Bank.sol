// SPDX-License-Identifier: MIT
// Depends on Uniswap v4 (BUSL-1.1)

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

contract BankERC20 is ERC20 {
    address public immutable bank;

    error OnlyBank();

    modifier onlyBank() {
        if (msg.sender != bank) revert OnlyBank();
        _;
    }

    constructor(
        address bankAddress,
        string memory name,
        string memory symbol
    ) ERC20(name, symbol) {
        bank = bankAddress;
    }

    function mint(address to, uint256 amount) external onlyBank {
        _mint(to, amount);
    }

    function burn(uint256 amount) external onlyBank {
        _burn(msg.sender, amount);
    }

    function burnFrom(address from, uint256 amount) external onlyBank {
        _burn(from, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}

contract Bank is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    using SafeERC20 for BankERC20;
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
    address public constant DEMO_COLLATERAL_ASSET_ADDRESS = 0x18084fbA666a33d37592fA2633fD49a74DD93a88;
    IPoolManager public constant POOL_MANAGER = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    IPositionManager public constant POSITION_MANAGER = IPositionManager(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e);

    // --------------------
    // Core system assets
    // --------------------

    IERC20 public immutable collateralAsset;
    BankERC20 public immutable bankShare;
    BankERC20 public immutable stablecoin;
    BankERC20 public immutable memecoin;

    // --------------------
    // System parameters
    // --------------------

    uint256 public constant DECIMALS = 1e18;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // liquidity pool parameters
    uint24 public constant UNISWAP_POOL_FEE = 3000;
    int24 public constant UNISWAP_TICK_SPACING = 60;

    // Total amount of bankShare minted to seed the liquidity pool.
    // This is the only bankShare that will ever be minted.
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

    // the protocol redirects treasuryAllocationBps of protocol earnings
    // (both from protocol-owned liquidity and from appreciation of underlying
    // collateral) to the TreasuryVault.
    // The TreasuryVault can:
    //   1) send funds back to the bank (to be burned or distributed to stakers)
    //   2) use funds to provide liquidity to pools on uniswap/curve/etc,
    //      increasing the amount of on-chain protocol-owned liquidity.
    // The TreasuryVault cannot send funds to the operator of the protocol.
    uint256 public constant MAX_TREASURY_ALLOCATION_BPS = 5000;
    // invariant: treasuryAllocationBps <= MAX_TREASURY_ALLOCATION_BPS
    uint256 public treasuryAllocationBps = 2000;

    // Users can donate() to the bank in exchange for a "memecoin"
    // Intended for gamification and community engagement. Protocol operators can:
    //   - Create leaderboards for top donors
    //   - Build games, virtual real estate, etc using memecoin as currency
    //     -> incentivizes minting memecoin -> more revenue for protocol
    // Not redeemable for collateral - purely for fun/community
    uint256 public constant MAX_MEMECOIN_MULTIPLIER_BPS = 10000;
    // invariant: memecoinMultiplier <= MAX_MEMECOIN_MULTIPLIER
    uint256 public memecoinMultiplierBps = 1000;

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

    // --------------------
    // System state
    // --------------------

    uint256 public lastHarvested = 0;
    uint256 public totalHarvested = 0;
    uint256 public stablecoinBurnedFromRedemption = 0;
    uint256 public stablecoinBurnedByPolicy = 0;

    // --------------------
    // Liquidity pool state
    // --------------------

    PoolKey public poolKey;
    uint256 public tokenId = 0; // tokenId of current liquidity position
    bool public poolInitialized = false;

    // --------------------
    // Vaults
    // --------------------

    StakingVault public immutable stakingVault;
    TreasuryVault public immutable treasuryVault;

    // --------------------
    // Events
    // --------------------

    event LiquidityPoolInitialized();
    event StablecoinMinted(address indexed user, uint256 collateralDeposited, uint256 stablesMinted);
    event StablecoinRedeemed(address indexed user, uint256 stablesBurned, uint256 collateralReturned);
    event StablecoinBurned(uint256 amount, BurnReason reason);
    event MemecoinBurned(address indexed user, uint256 amount);
    event LiquidityRewardsCollected(
        address indexed caller,
        uint256 amountHarvestedFromPool,
        uint256 amountMinted,
        uint256 amountToStakers,
        uint256 amountToTreasury,
        uint256 amountBurned,
        uint256 amountToCaller
    );
    event Donation(
        address indexed donor,
        uint256 donationAmount,
        uint256 amountToStakers,
        uint256 amountToTreasury,
        uint256 amountBurned,
        uint256 memecoinMinted
    );
    event StablecoinReturnedFromTreasury(
        uint256 amountReturned,
        uint256 amountToStakers,
        uint256 amountBurned
    );
    event TargetCollateralRatioUpdated(address indexed caller, uint256 oldRatioBps, uint256 newRatioBps);
    event StablecoinBurnRatioUpdated(address indexed caller, uint256 oldRatioBps, uint256 newRatioBps);
    event MemecoinMultiplierUpdated(address indexed caller, uint256 oldMultiplier, uint256 newMultiplier);
    event MintFeeUpdated(address indexed caller, uint256 oldFeeBps, uint256 newFeeBps);
    event RedemptionFeeUpdated(address indexed caller, uint256 oldFeeBps, uint256 newFeeBps);
    event CallerRewardUpdated(address indexed caller, uint256 oldRewardBps, uint256 newRewardBps);
    event TreasuryAllocationUpdated(address indexed caller, uint256 oldAllocationBps, uint256 newAllocationBps);

    // --------------------
    // Errors
    // --------------------

    error OnlyTreasuryVault();
    error OutOfRange();
    error AmountZero();
    error Expired();
    error PoolAlreadyInitialized();
    error PriceBoundViolated();

    // --------------------
    // Modifiers
    // --------------------

    modifier onlyTreasuryVault() {
        if (msg.sender != address(treasuryVault)) revert OnlyTreasuryVault();
        _;
    }

    // --------------------
    // Protocol initialization
    // --------------------

    constructor() Ownable(msg.sender) {
        collateralAsset = IERC20(DEMO_COLLATERAL_ASSET_ADDRESS);
        stablecoin = new BankERC20(address(this), "STABLE", "STABLE");
        bankShare = new BankERC20(address(this), "SHARE", "SHARE");
        memecoin = new BankERC20(address(this), "MEME", "MEME");
        stakingVault = new StakingVault(address(this), stablecoin, bankShare);
        treasuryVault = new TreasuryVault(msg.sender, stablecoin, address(this));

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
        stablecoin.approve(address(treasuryVault), type(uint256).max);
    }

    function initializeLiquidityPool(address poolHooks) public {
        if (poolInitialized) revert PoolAlreadyInitialized();

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
            TickMath.minUsableTick(UNISWAP_TICK_SPACING),
            TickMath.maxUsableTick(UNISWAP_TICK_SPACING)
        );

        poolInitialized = true;
        emit LiquidityPoolInitialized();
    }

    // --------------------
    // Mint / Redeem
    // --------------------

    /**
     * @notice Mint stablecoin by depositing collateral.
     * @dev Minting requires $1 of collateral per stablecoin at the current oracle price,
     *      plus a protocol fee (mintFeeBps) to discourage oracle lag arbitrage and
     *      reinforce the protocol's collateral ratio.
     */
    function mintStablecoin(
        uint256 amountToMint,
        uint256 maxAmountIn,
        uint256 deadline
    )
        external
        nonReentrant
        returns (uint256) 
    {
        if (amountToMint == 0) revert AmountZero();
        if (block.timestamp > deadline) revert Expired();

        // round up
        uint256 amountToDeposit = Math.mulDiv(amountToMint, DECIMALS, getPrice(), Math.Rounding.Ceil);
        if (amountToDeposit > maxAmountIn) revert PriceBoundViolated();

        // pull exactly that much collateral
        collateralAsset.safeTransferFrom(msg.sender, address(this), amountToDeposit);

        // apply minting fee
        amountToMint = Math.mulDiv(amountToMint, BPS_DENOMINATOR - mintFeeBps, BPS_DENOMINATOR);
        stablecoin.mint(msg.sender, amountToMint);

        emit StablecoinMinted(msg.sender, amountToDeposit, amountToMint);
        return amountToMint;
    }

    /**
     * @notice Redeem stablecoin for collateral.
     * @dev Each stablecoin redeemed returns $1 of collateral at the current oracle price,
     *      minus a protocol fee (redemptionFeeBps) to discourage oracle lag arbitrage
     *      and reinforce the protocol's collateral ratio.
     */
    function redeemStablecoin(
        uint256 amountToRedeem,
        uint256 minAmountOut,
        uint256 deadline
    ) 
        external
        nonReentrant
        returns (uint256) 
    {
        if (amountToRedeem == 0) revert AmountZero();
        if (block.timestamp > deadline) revert Expired();

        // Round down
        uint256 withdrawalAmount = Math.mulDiv(amountToRedeem, DECIMALS, getPrice(), Math.Rounding.Floor);

        // apply redemption fee
        withdrawalAmount = Math.mulDiv(withdrawalAmount, BPS_DENOMINATOR - redemptionFeeBps, BPS_DENOMINATOR);
        if (withdrawalAmount < minAmountOut) revert PriceBoundViolated();

        stablecoin.safeTransferFrom(msg.sender, address(this), amountToRedeem);

        _burnStablecoin(amountToRedeem, BurnReason.Redemption);

        collateralAsset.safeTransfer(msg.sender, withdrawalAmount);

        emit StablecoinRedeemed(msg.sender, amountToRedeem, withdrawalAmount);
        return withdrawalAmount;
    }

    // --------------------
    // Rewards / Policy
    // --------------------

    /**
     * @notice Harvest liquidity pool fees and apply protocol policy.
     * @dev Collects fees from the protocol-owned stablecoin/bankShare LP position. Any harvested bankShare
     *      is swapped to stablecoin (not burned) to preserve pool depth and maximize long-run fee yield.
     *
     *      The harvested stablecoin is then allocated according to policy:
     *        - caller incentive (callerRewardBps),
     *        - TreasuryVault allocation (treasuryAllocationBps),
     *        - burn to improve collateral ratio (stablecoinBurnRatioBps),
     *        - remainder to stakers.
     *
     *      If the protocol is overcollateralized relative to targetCollateralRatioBps, additional stablecoin
     *      is minted and distributed to stakers/treasury to bring redeemable supply up to target.
     *      If no stakers exist, any staker allocation is burned to avoid stranded value.
     */
    function harvestFees() external nonReentrant {
        uint256 stablecoinBalanceBeforeHarvest = stablecoin.balanceOf(address(this));

        Uni4All.collectFeesFromLiquidityPool(stablecoin, bankShare, tokenId);

        uint256 bankShareBalance = bankShare.balanceOf(address(this));
        if (bankShareBalance > 0) {
            // We have two choices here.
            // (1) Burn bankShare:
            //     + makes bankShare deflationary (supports price)
            //     - gradually thins pool depth (less arbitrage / volume) -> lower fee yield
            // (2) Sell bankShare back into the pool for stablecoin:
            //     + keeps bankShare supply stable
            //     + preserves pool depth (supports arbitrage / volume) -> higher long-run fee yield
            //     + converts fees into stablecoin that can be distributed to stakers and/or burned
            //       to improve collateral ratio (policy-dependent)
            // We choose (2) to maximize sustainable yield and maintain pool strength.
            Uni4All.swapTokens(address(bankShare), address(stablecoin), uint128(bankShareBalance), poolKey);
        }

        uint256 stablecoinBalanceAfterHarvest = stablecoin.balanceOf(address(this));

        // split harvested funds
        uint256 amountHarvested  = stablecoinBalanceAfterHarvest - stablecoinBalanceBeforeHarvest;
        uint256 callerReward     = Math.mulDiv(amountHarvested, callerRewardBps, BPS_DENOMINATOR);
        uint256 amountToTreasury = Math.mulDiv(amountHarvested, treasuryAllocationBps, BPS_DENOMINATOR);
        uint256 amountToBurn     = Math.mulDiv(amountHarvested, stablecoinBurnRatioBps, BPS_DENOMINATOR, Math.Rounding.Ceil);

        // ensure burn doesn't exceed available funds
        uint256 remaining = amountHarvested - callerReward - amountToTreasury;
        if (amountToBurn > remaining) {
            amountToBurn = remaining;
        }

        uint256 amountToStakers = remaining - amountToBurn;

        // mint stablecoin if overcollateralized; send to stakers/treasury according to treasuryAllocationBps
        uint256 stablecoinSupply = redeemableStablecoinSupply();
        uint256 supplyAtTargetRatio = Math.mulDiv(valueOfCollateral(), BPS_DENOMINATOR, targetCollateralRatioBps);
        uint256 amountToMint = 0;
        if (supplyAtTargetRatio > stablecoinSupply) {
            amountToMint = supplyAtTargetRatio - stablecoinSupply;
            uint256 amountOfMintToTreasury = Math.mulDiv(amountToMint, treasuryAllocationBps, BPS_DENOMINATOR);
            amountToTreasury += amountOfMintToTreasury;
            amountToStakers += (amountToMint - amountOfMintToTreasury);
        }

        // handle edge case: no stakers
        if (amountToStakers > 0 && stakingVault.totalStaked() == 0) {
            amountToBurn += amountToStakers;
            amountToStakers = 0;
        }

        // execute distributions
        if (amountToMint > 0) {
            stablecoin.mint(address(this), amountToMint);
        }
        if (amountToStakers > 0) {
            stakingVault.deposit(amountToStakers);
        }
        if (amountToTreasury > 0) {
            treasuryVault.deposit(amountToTreasury);
        }
        if (callerReward > 0) {
            stablecoin.safeTransfer(msg.sender, callerReward);
        }
        if (amountToBurn > 0) {
            _burnStablecoin(amountToBurn, BurnReason.Policy);
        }

        lastHarvested = block.timestamp;
        totalHarvested += amountHarvested;
        emit LiquidityRewardsCollected(
            msg.sender,
            amountHarvested,
            amountToMint,
            amountToStakers,
            amountToTreasury,
            amountToBurn,
            callerReward
        );
    }

    /**
     * @notice Donate stablecoin to protocol stakers.
     * @dev Intended primarily for protocol-controlled revenue sources (e.g. frontend
     *      fees, vault management fees, or other protocol income). Donated funds are
     *      allocated according to policy: partially burned, distributed to stakers,
     *      and/or routed to the TreasuryVault (via stablecoinBurnRatioBps and
     *      treasuryAllocationBps).
     *
     *      External users may also donate() in exchange for memecoin, which has no
     *      intrinsic protocol value but may be used as a general-purpose utility
     *      token (e.g. games, virtual assets).
     */
    function donate(uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountZero();

        stablecoin.safeTransferFrom(msg.sender, address(this), amount);

        uint256 amountToTreasury = Math.mulDiv(amount, treasuryAllocationBps, BPS_DENOMINATOR);
        uint256 amountToStakers = amount - amountToTreasury;
        uint256 amountToBurn = Math.mulDiv(amountToStakers, stablecoinBurnRatioBps, BPS_DENOMINATOR);
        amountToStakers -= amountToBurn;

        if (stakingVault.totalStaked() == 0) {
            amountToBurn += amountToStakers;
            amountToStakers = 0;
        }

        if (amountToStakers > 0) {
            stakingVault.deposit(amountToStakers);
        }
        if (amountToTreasury > 0) {
            treasuryVault.deposit(amountToTreasury);
        }
        if (amountToBurn > 0) {
            _burnStablecoin(amountToBurn, BurnReason.Policy);
        }

        // mint a comically large amount of memecoins to reward the donor with.
        uint256 memecoinToMint = amount * memecoinMultiplierBps;
        memecoin.mint(msg.sender, memecoinToMint);

        emit Donation(
            msg.sender,
            amount,
            amountToStakers,
            amountToTreasury,
            amountToBurn,
            memecoinToMint
        );
    }

    /**
     * @notice Return stablecoin from the TreasuryVault to the protocol
     * @dev Policy hook for returning excess TreasuryVault profits to the protocol.
     *      The TreasuryVault provides stablecoin liquidity to AMMs.
     *      Profits from LP activity may be returned to the Bank via
     *      returnStablecoinToBank(), which burns a portion according to
     *      stablecoinBurnRatioBps and distributes the remainder to stakers.
     *      Only the TreasuryVault may call this function; all other inflows
     *      should use donate().
     */
    function returnStablecoinToBank(uint256 amount) external onlyTreasuryVault nonReentrant {
        if (amount == 0) revert AmountZero();

        stablecoin.safeTransferFrom(msg.sender, address(this), amount);

        uint256 amountToBurn = Math.mulDiv(amount, stablecoinBurnRatioBps, BPS_DENOMINATOR);
        uint256 amountToStakers = amount - amountToBurn;

        if (stakingVault.totalStaked() == 0) {
            amountToBurn += amountToStakers;
            amountToStakers = 0;
        }

        if (amountToStakers > 0) {
            stakingVault.deposit(amountToStakers);
        }
        if (amountToBurn > 0) {
            _burnStablecoin(amountToBurn, BurnReason.Policy);
        }

        emit StablecoinReturnedFromTreasury(
            amount,
            amountToStakers,
            amountToBurn
        );
    }

    // --------------------
    // Burning
    // --------------------

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

    function burnMemecoin(uint256 amount) external {
        if (amount == 0) revert AmountZero();
        memecoin.burnFrom(msg.sender, amount);
        emit MemecoinBurned(msg.sender, amount);
    }

    // --------------------
    // Views
    // --------------------

    function getPrice() public view returns (uint256) {
        return OracleLib.getLatestPrice();
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

    /**
     * @notice Supply of redeemable stablecoin
     * @dev At deployment, TOTAL_SHARE_SUPPLY stablecoin and TOTAL_SHARE_SUPPLY bankShare are minted 1:1
     *      and deposited into the stablecoin/bankShare liquidity pool at a 1:1 price.
     *
     *      The initial stablecoin is not redeemable for collateral because it is permanently paired
     *      with a fixed supply of bankShare. No additional bankShare can ever be minted, so extracting
     *      stablecoin from the pool necessarily requires returning bankShare to the pool.
     *
     *      BankShare can only be acquired by minting new stablecoin via mintStablecoin() and purchasing
     *      it from the pool. When bankShare is later sold back into the pool, the seller recovers only
     *      the stablecoin they previously introduced (per AMM invariants), leaving the initial
     *      TOTAL_SHARE_SUPPLY stablecoin structurally locked.
     */
    function redeemableStablecoinSupply() public view returns (uint256) {
        return stablecoin.totalSupply() - TOTAL_SHARE_SUPPLY;
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
        if (ratio < MIN_TARGET_COLLATERAL_RATIO_BPS) revert OutOfRange();
        uint256 oldRatio = targetCollateralRatioBps;
        targetCollateralRatioBps = ratio;
        emit TargetCollateralRatioUpdated(msg.sender, oldRatio, ratio);
    }

    function setStablecoinBurnRatio(uint256 ratio) external onlyOwner {
        if (ratio > BPS_DENOMINATOR) revert OutOfRange();
        uint256 oldRatio = stablecoinBurnRatioBps;
        stablecoinBurnRatioBps = ratio;
        emit StablecoinBurnRatioUpdated(msg.sender, oldRatio, ratio);
    }

    function setMemecoinMultiplier(uint256 multiplier) external onlyOwner {
        if (multiplier == 0 || multiplier > MAX_MEMECOIN_MULTIPLIER_BPS) revert OutOfRange();
        uint256 oldMultiplier = memecoinMultiplierBps;
        memecoinMultiplierBps = multiplier;
        emit MemecoinMultiplierUpdated(msg.sender, oldMultiplier, multiplier);
    }

    function setRedemptionFee(uint256 fee) external onlyOwner {
        if (fee > MAX_REDEMPTION_FEE_BPS) revert OutOfRange();
        uint256 oldFee = redemptionFeeBps;
        redemptionFeeBps = fee;
        emit RedemptionFeeUpdated(msg.sender, oldFee, fee);
    }

    function setMintFee(uint256 fee) external onlyOwner {
        if (fee > MAX_MINT_FEE_BPS) revert OutOfRange();
        uint256 oldFee = mintFeeBps;
        mintFeeBps = fee;
        emit MintFeeUpdated(msg.sender, oldFee, fee);
    }

    function setCallerReward(uint256 reward) external onlyOwner {
        if (reward > MAX_CALLER_REWARD_BPS) revert OutOfRange();
        uint256 oldReward = callerRewardBps;
        callerRewardBps = reward;
        emit CallerRewardUpdated(msg.sender, oldReward, reward);
    }

    function setTreasuryAllocation(uint256 allocation) external onlyOwner {
        if (allocation > MAX_TREASURY_ALLOCATION_BPS) revert OutOfRange();
        uint256 oldAllocation = treasuryAllocationBps;
        treasuryAllocationBps = allocation;
        emit TreasuryAllocationUpdated(msg.sender, oldAllocation, allocation);
    }
}

contract StakingVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant DECIMALS = 1e18;

    uint256 public totalStaked = 0;
    uint256 public rewardPerShare = 0;

    mapping(address => uint256) public stakeAmount;
    mapping(address => uint256) public rewardDebt;

    IERC20 public immutable stablecoin;
    IERC20 public immutable bankShare;

    address public immutable bank;

    event Claimed(address indexed user, uint256 reward);
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Deposited(address indexed from, uint256 amount, uint256 rewardPerShare);

    error OnlyBank();
    error AmountZero();

    modifier onlyBank() {
        if (msg.sender != bank) revert OnlyBank();
        _;
    }

    constructor(address _bank, IERC20 _stablecoin, IERC20 _bankShare) {
        bank = _bank;
        stablecoin = _stablecoin;
        bankShare = _bankShare;
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountZero();

        _claim();

        bankShare.safeTransferFrom(msg.sender, address(this), amount);

        stakeAmount[msg.sender] += amount;
        totalStaked += amount;
        rewardDebt[msg.sender] = Math.mulDiv(stakeAmount[msg.sender], rewardPerShare, DECIMALS);

        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountZero();

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
        // Safe: accumulated >= rewardDebt by algorithm invariant (rewardPerShare only increases)
        uint256 pending = accumulated - rewardDebt[msg.sender];
        if (pending > 0) {
            stablecoin.safeTransfer(msg.sender, pending);
            emit Claimed(msg.sender, pending);
        }
        rewardDebt[msg.sender] = accumulated;
    }

    function deposit(uint256 amount) external onlyBank nonReentrant {
        if (amount == 0 || totalStaked == 0) revert AmountZero();
        stablecoin.safeTransferFrom(msg.sender, address(this), amount);
        rewardPerShare += Math.mulDiv(amount, DECIMALS, totalStaked);
        emit Deposited(msg.sender, amount, rewardPerShare);
    }

    // withdraw without collecting rewards. EMERGENCY ONLY
    function emergencyWithdraw() external nonReentrant {
        uint256 amount = stakeAmount[msg.sender];
        if (amount > 0) {
            totalStaked -= amount;
            stakeAmount[msg.sender] = 0;
            rewardDebt[msg.sender] = 0;
            bankShare.safeTransfer(msg.sender, amount);
            emit Unstaked(msg.sender, amount);
        }
    }

    function pendingRewards(address user) external view returns (uint256) {
        uint256 accumulated = Math.mulDiv(stakeAmount[user], rewardPerShare, DECIMALS);
        // Safe: accumulated >= rewardDebt by algorithm invariant (rewardPerShare only increases)
        return accumulated - rewardDebt[user];
    }

    function getUserInfo(address user) external view returns (uint256 staked, uint256 debt, uint256 pending) {
        staked = stakeAmount[user];
        debt = rewardDebt[user];
        uint256 accumulated = Math.mulDiv(staked, rewardPerShare, DECIMALS);
        // Safe: accumulated >= rewardDebt by algorithm invariant (rewardPerShare only increases)
        pending = accumulated - debt;
    }
}

contract TreasuryVault is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable stablecoin;
    Bank public immutable bank;

    event Deposited(uint256 amount);
    event Returned(uint256 amount);

    error OnlyBank();
    error AmountZero();

    modifier onlyBank() {
        if (msg.sender != address(bank)) revert OnlyBank();
        _;
    }

    constructor(address owner, IERC20 _stablecoin, address _bank) Ownable(owner) {
        stablecoin = _stablecoin;
        bank = Bank(_bank);

        stablecoin.approve(address(bank), type(uint256).max);
    }

    function returnToBank(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert AmountZero();
        bank.returnStablecoinToBank(amount);
        emit Returned(amount);
    }

    function deposit(uint256 amount) external onlyBank nonReentrant {
        if (amount == 0) revert AmountZero();
        stablecoin.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(amount);
    }
}

contract PoolHooks is BaseHook {
    using StateLibrary for IPoolManager;

    error OnlyBank();

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
     * @dev Since Uniswap v4 hooks cannot easily access the original caller (msg.sender is always
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
        if (liquidity > 0) revert OnlyBank();
        return BaseHook.beforeAddLiquidity.selector;
    }
}
