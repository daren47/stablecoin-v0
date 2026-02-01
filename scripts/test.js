process.env.HARDHAT_LOGGING_LEVEL = "error";

const { ethers, network } = require("hardhat");
const { MaxUint256 } = require("ethers");

const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";

const LABEL_WIDTH = 28
function row(label, value) {
  console.log("  " + label.padEnd(LABEL_WIDTH, " ") + value);
}

function deltaRow(label, before, after, format = true) {
  let delta = after - before;
  if (delta < 0) {
    if (format) {
      delta = fmt(delta);
    } else {
      delta = delta.toString();
    }
  } else {
    if (format) {
      delta = "+" + fmt(delta);
    } else {
      delta = "+" + delta;
    }
  }
  if (format) {
      before = fmt(before);
      after = fmt(after);
  } else {
      before = before.toString();
      after = after.toString();
  }
  const VALUE_WIDTH = 12;

  const l = label.padEnd(LABEL_WIDTH, " ");
  const b = before.padEnd(VALUE_WIDTH, " ");
  const a = after.padEnd(VALUE_WIDTH, " ");
  const d = delta.padEnd(14, " ");

  console.log(`  ${l}${b}->  ${a}(Δ ${delta})`);
}

// swap tokenIn for tokenOut using uniswap
async function doSwap(sender, tokenIn, tokenOut, amount, hookAddress, swapHelper) {
    let tx = await swapHelper.connect(sender).swapTokens(tokenIn, tokenOut, hookAddress, ethers.parseUnits(amount));
    await tx.wait()
}

// uniswap reverts some transactions if they happen within the same block.
// For example, it reverts if you attempt to swap through a liquidity pool
// in the same block that it is created.
// It also reverts if you attempt to withdraw a liquidity position in the
// same block in which you create it.
// This function is the hacky way I got execution to pause for long enough
// for a new block to be mined.
async function wait() {
    console.log("Waiting one block...");
    await ethers.provider.send("evm_mine");
    await new Promise(resolve => setTimeout(resolve, 3000));
    await ethers.provider.send("evm_mine");
    console.log("Done waiting\n.");
}

// pause execution for a moment, so that you have time to read the helpful text the demo prints :)
async function pause() {
    await new Promise(resolve => setTimeout(resolve, 3000));
}

function fmt(num, decimals = 18, displayDecimals = 4) {
  const s = ethers.formatUnits(num, decimals);
  const [i, f = ""] = s.split(".");
  return f
    ? `${i}.${f.slice(0, displayDecimals)}`
    : i;
}

async function main() {
    let checks = 0;
    let passed = 0;
    let failed = 0;

    function expect(bool, passMsg, failMsg) {
        checks += 1;
        if (bool) {
            passed += 1;
            console.log("ok:", passMsg);
        } else {
            failed += 1;
            console.log("fail:", failMsg);
        }
    }

    console.log("[hardhat] reset\n");
    await network.provider.request({
        method: "hardhat_reset",
        params: [{
            forking: {
                jsonRpcUrl: "https://mainnet.infura.io/v3/79d6d784f40348059b19259fe48a779e",
                blockNumber: 22876667,
            },
        }],
    });

    const [dev, alice, bob] = await ethers.getSigners();
    const devAddress = await dev.getAddress();
    const aliceAddress = await alice.getAddress();

    console.log("[deploy] contracts");

    const SwapHelper = await ethers.getContractFactory("SwapHelper");
    const swapHelper = await SwapHelper.deploy();
    await swapHelper.waitForDeployment();

    const Bank = await ethers.getContractFactory("Bank");
    const bank = await Bank.deploy();
    await bank.waitForDeployment();
    const bankAddress = await bank.getAddress();
    row("bank address:", bankAddress);

    const stablecoinAddress = await bank.stablecoin();
    let tmp = await ethers.getContractFactory("BankERC20");
    const stablecoin = tmp.attach(stablecoinAddress);
    row("stablecoin address:", stablecoinAddress);

    const bankShareAddress = await bank.bankShare();
    tmp = await ethers.getContractFactory("BankERC20");
    const bankShare = tmp.attach(bankShareAddress);
    row("bankShare address:", bankShareAddress);

    const stakingVaultAddress = await bank.stakingVault();
    tmp = await ethers.getContractFactory("StakingVault");
    const stakingVault = tmp.attach(stakingVaultAddress);
    row("staking vault address:", stakingVaultAddress);

    const initialStablecoinSupply = await stablecoin.totalSupply();
    const initialBankShareSupply = await bankShare.totalSupply();
    const totalShareSupply = await bank.TOTAL_SHARE_SUPPLY();
    row("TOTAL_SHARE_SUPPLY:", fmt(totalShareSupply));
    row("stablecoin supply:", fmt(initialStablecoinSupply));
    row("bankShare supply:", fmt(initialBankShareSupply));
    expect(initialStablecoinSupply == totalShareSupply && initialBankShareSupply == totalShareSupply,
        "contracts deployed, coins minted",
        "initial supply mismatched"
    )
    console.log("");

    console.log("[deploy] uniswap v4 hook (create2)");
    // deploy Create2Factory 
    const Factory = await ethers.getContractFactory("Create2Factory");
    const factory = await Factory.deploy();
    await factory.waitForDeployment();
    const factoryAddr = await factory.getAddress();
    const Hook = await ethers.getContractFactory("PoolHooks");
    const encodedArgs = Hook.interface.encodeDeploy([POOL_MANAGER]);
    const hookInitCode = Hook.bytecode + encodedArgs.slice(2);
    const initCodeHash = ethers.keccak256(hookInitCode);
    // brute-force a salt ending in "840"
    let saltFound, targetAddress;
    const desiredBitmap = (1 << 11);  // beforeAddLiquidity
    const mask14        = (1 << 14) - 1;
    for (let i = 0; i < 10_000_000; i++) {
        const hex = i.toString(16).padStart(64, "0");
        const salt = "0x" + hex;
        const addr = ethers.getCreate2Address(factoryAddr, salt, initCodeHash);
        if ((parseInt(addr.slice(-4), 16) & mask14) === desiredBitmap) {
            saltFound     = salt;
            targetAddress = addr;
            row("create2 salt:", salt);
            row("target address:", targetAddress);
            break;
        }
    }
    // deploy via CREATE2
    const hookAddress = await factory.deploy.staticCall(hookInitCode, saltFound);
    let tx = await factory["deploy(bytes,bytes32)"](hookInitCode, saltFound, {
        gasLimit: 10_000_000,
    });
    receipt = await tx.wait();
    row("hook deployed:", hookAddress);
    expect(targetAddress == hookAddress, "hook deployed, address compliant", "incompatible address");
    console.log("");

    console.log("[initialize] liquidity pool (bank deposits full stablecoin/bankShare balance)");
    let bankBankShareBalanceBefore = await bankShare.balanceOf(bankAddress);
    let bankStablecoinBalanceBefore = await stablecoin.balanceOf(bankAddress);
    let poolBankShareBefore = await bankShare.balanceOf(POOL_MANAGER);
    let poolStablecoinBefore = await stablecoin.balanceOf(POOL_MANAGER);
    tx = await bank.connect(dev).initializeLiquidityPool(hookAddress);
    await tx.wait();
    let bankBankShareBalanceAfter = await bankShare.balanceOf(bankAddress);
    let bankStablecoinBalanceAfter = await stablecoin.balanceOf(bankAddress);
    let poolBankShareAfter = await bankShare.balanceOf(POOL_MANAGER);
    let poolStablecoinAfter = await stablecoin.balanceOf(POOL_MANAGER);
    deltaRow("bank bankShare:", bankBankShareBalanceBefore, bankBankShareBalanceAfter);
    deltaRow("bank stablecoin:", bankStablecoinBalanceBefore, bankStablecoinBalanceAfter);
    deltaRow("pool bankShare:", poolBankShareBefore, poolBankShareAfter);
    deltaRow("pool stablecoin:", poolStablecoinBefore, poolStablecoinAfter);
    expect(
        bankBankShareBalanceAfter == 0 &&
        bankStablecoinBalanceAfter == 0 &&
        poolBankShareAfter == totalShareSupply &&
        poolStablecoinAfter == totalShareSupply,
        "pool balances match bank deposits",
        "liquidity pool initialization failed"
    )
    console.log("")
    //await wait();

    //const block = await ethers.provider.getBlockNumber();

    const tbtc_address = "0x18084fbA666a33d37592fA2633fD49a74DD93a88".toLowerCase(); // mainnet tBTC
    const tbtc_holder = "0x466C71131278ad54C555489BbfbdAC37E838f99C".toLowerCase();

    await network.provider.send("hardhat_setBalance", [
        tbtc_holder,
        ethers.toBeHex(ethers.parseEther("10")),
    ]);

    await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [tbtc_holder],
    });
    const whaleSigner = await ethers.getSigner(tbtc_holder);

    const tbtc = await ethers.getContractAt(
        [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function transfer(address to, uint256 amount) returns (bool)",
            "function transferFrom(address from, address to, uint256 amount) returns (bool)",
            "function approve(address spender, uint256 amount) returns (bool)",
            "function allowance(address owner, address spender) view returns (uint256)"
        ],
        tbtc_address
    );

    console.log("[fund] impersonate whale -> seed accounts (tBTC)");
    row("whale address:", whaleSigner.address);
    let whaleBalance = await tbtc.balanceOf(whaleSigner.address);
    row("whale before:", fmt(whaleBalance));

    let amount = ethers.parseUnits("1.0", 18);
    tx = await tbtc.connect(whaleSigner).transfer(await dev.getAddress(), amount);
    await tx.wait();

    amount = ethers.parseUnits("0.3", 18);
    tx = await tbtc.connect(whaleSigner).transfer(await alice.getAddress(), amount);
    await tx.wait();

    whaleBalance = await tbtc.balanceOf(whaleSigner.address);
    row("whale after:", fmt(whaleBalance));
    let devBalance = await tbtc.balanceOf(devAddress);
    row("dev balance:", fmt(devBalance));
    let aliceBalance = await tbtc.balanceOf(aliceAddress);
    row("alice balance:", fmt(aliceBalance));
    expect(devBalance > 0 && aliceBalance > 0, "dev and alice seeded", "impersonation failed");
    console.log("");

    await tbtc.connect(dev).approve(bankAddress, MaxUint256);
    await stablecoin.connect(dev).approve(bankAddress, MaxUint256);
    await bankShare.connect(dev).approve(bankAddress, MaxUint256);
    await bankShare.connect(dev).approve(stakingVaultAddress, MaxUint256);
    await tbtc.connect(alice).approve(bankAddress, MaxUint256);
    await stablecoin.connect(alice).approve(bankAddress, MaxUint256);
    await bankShare.connect(alice).approve(bankAddress, MaxUint256);
    await bankShare.connect(alice).approve(stakingVaultAddress, MaxUint256);

    console.log("[oracle] check tBTC price");
    const tbtcPrice = await bank.getPrice();
    row("tBTC price:", ethers.formatUnits(tbtcPrice, 18));
    expect(tbtcPrice > 0, "oracle read", "oracle failed");
    console.log("");

    console.log("[mint] dev minting stablecoin (actor 1/2)")
    let stablecoinSupplyBefore = await stablecoin.totalSupply();
    let redeemableSupplyBefore = await bank.redeemableStablecoinSupply();
    let bankTbtcBefore = await tbtc.balanceOf(bankAddress);
    let devTbtcBefore = await tbtc.balanceOf(devAddress);
    let devStablecoinBefore = await stablecoin.balanceOf(devAddress);
    await bank.connect(dev).mintStablecoin(ethers.parseUnits("50000.00", 18), MaxUint256, MaxUint256);
    let stablecoinSupplyAfter = await stablecoin.totalSupply();
    let redeemableSupplyAfter = await bank.redeemableStablecoinSupply();
    let bankTbtcAfter = await tbtc.balanceOf(bankAddress);
    let devTbtcAfter = await tbtc.balanceOf(devAddress);
    let devStablecoinAfter = await stablecoin.balanceOf(devAddress);
    deltaRow("dev stablecoin:", devStablecoinBefore, devStablecoinAfter);
    deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
    deltaRow("redeemable supply:", redeemableSupplyBefore, redeemableSupplyAfter);
    deltaRow("bank tBTC:", bankTbtcBefore, bankTbtcAfter)
    deltaRow("dev tBTC:", devTbtcBefore, devTbtcAfter);
    expect(
        devStablecoinAfter > devStablecoinBefore &&
        devTbtcAfter < devTbtcBefore &&
        stablecoinSupplyAfter > stablecoinSupplyBefore &&
        bankTbtcAfter > bankTbtcBefore,
        "deltas ok (dev +stablecoin/-tBTC, bank +tBTC, supply +stablecoin)",
        "unexpected deltas"
    )
    console.log("")

    console.log("[mint] alice minting stablecoin (actor 2/2)")
    stablecoinSupplyBefore = await stablecoin.totalSupply();
    redeemableSupplyBefore = await bank.redeemableStablecoinSupply();
    bankTbtcBefore = await tbtc.balanceOf(bankAddress);
    let aliceTbtcBefore = await tbtc.balanceOf(aliceAddress);
    let aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
    tx = await bank.connect(alice).mintStablecoin(ethers.parseUnits("20000.00", 18), MaxUint256, MaxUint256);
    await tx.wait();
    stablecoinSupplyAfter = await stablecoin.totalSupply();
    redeemableSupplyAfter = await bank.redeemableStablecoinSupply();
    bankTbtcAfter = await tbtc.balanceOf(bankAddress);
    let aliceTbtcAfter = await tbtc.balanceOf(aliceAddress);
    let aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
    deltaRow("alice stablecoin:", aliceStablecoinBefore, aliceStablecoinAfter);
    deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
    deltaRow("redeemable supply:", redeemableSupplyBefore, redeemableSupplyAfter);
    deltaRow("bank tBTC:", bankTbtcBefore, bankTbtcAfter)
    deltaRow("alice tBTC:", aliceTbtcBefore, aliceTbtcAfter);
    expect(
        aliceStablecoinAfter > aliceStablecoinBefore &&
        aliceTbtcAfter < aliceTbtcBefore &&
        stablecoinSupplyAfter > stablecoinSupplyBefore &&
        bankTbtcAfter > bankTbtcBefore,
        "deltas ok (alice +stablecoin/-tBTC, bank +tBTC, supply +stablecoin)",
        "unexpected deltas"
    )
    console.log("")

    console.log("[redeem] dev redeeming stablecoin");
    stablecoinSupplyBefore = await stablecoin.totalSupply();
    redeemableSupplyBefore = await bank.redeemableStablecoinSupply();
    bankTbtcBefore = await tbtc.balanceOf(bankAddress);
    devTbtcBefore = await tbtc.balanceOf(devAddress);
    devStablecoinBefore = await stablecoin.balanceOf(devAddress);
    tx = await bank.connect(dev).redeemStablecoin(ethers.parseUnits("50.00"), 0, MaxUint256);
    await tx.wait();
    stablecoinSupplyAfter = await stablecoin.totalSupply();
    redeemableSupplyAfter = await bank.redeemableStablecoinSupply();
    bankTbtcAfter = await tbtc.balanceOf(bankAddress);
    devTbtcAfter = await tbtc.balanceOf(devAddress);
    devStablecoinAfter = await stablecoin.balanceOf(devAddress);
    deltaRow("dev stablecoin:", devStablecoinBefore, devStablecoinAfter);
    deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
    deltaRow("redeemable supply:", redeemableSupplyBefore, redeemableSupplyAfter);
    deltaRow("bank tBTC:", bankTbtcBefore, bankTbtcAfter)
    deltaRow("dev tBTC:", devTbtcBefore, devTbtcAfter);
    expect(
        devStablecoinAfter < devStablecoinBefore &&
        devTbtcAfter > devTbtcBefore &&
        stablecoinSupplyAfter < stablecoinSupplyBefore &&
        bankTbtcAfter < bankTbtcBefore,
        "deltas ok (dev -stablecoin/+tBTC, bank -tBTC, supply -stablecoin)",
        "unexpected deltas"
    )
    console.log("")

    swapHelperAddress = await swapHelper.getAddress();

    await stablecoin.connect(dev).approve(swapHelperAddress, MaxUint256);
    await bankShare.connect(dev).approve(swapHelperAddress, MaxUint256);
    await stablecoin.connect(alice).approve(swapHelperAddress, MaxUint256);
    await bankShare.connect(alice).approve(swapHelperAddress, MaxUint256);

    console.log("[swap] alice purchasing bankShare with stablecoin");
    aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
    let aliceBankShareBefore = await bankShare.balanceOf(aliceAddress);
    poolStablecoinBefore = await stablecoin.balanceOf(POOL_MANAGER);
    poolBankShareBefore = await bankShare.balanceOf(POOL_MANAGER);
    await doSwap(alice, stablecoinAddress, bankShareAddress, "19000", hookAddress, swapHelper);
    aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
    aliceBankShareAfter = await bankShare.balanceOf(aliceAddress);
    poolStablecoinAfter = await stablecoin.balanceOf(POOL_MANAGER);
    poolBankShareAfter = await bankShare.balanceOf(POOL_MANAGER);
    deltaRow("pool stablecoin:", poolStablecoinBefore, poolStablecoinAfter);
    deltaRow("alice stablecoin:", aliceStablecoinBefore, aliceStablecoinAfter);
    deltaRow("pool bankShare:", poolBankShareBefore, poolBankShareAfter);
    deltaRow("alice bankShare:", aliceBankShareBefore, aliceBankShareAfter);
    expect(
        poolStablecoinAfter > poolStablecoinBefore &&
        poolBankShareAfter < poolBankShareBefore &&
        aliceStablecoinAfter < aliceStablecoinBefore &&
        aliceBankShareAfter > aliceBankShareBefore,
        "deltas ok (alice -stablecoin/+bankShare, pool +stablecoin/-bankShare)",
        "unexpected deltas"
    )
    console.log("");

    console.log("[stake] alice staking bankShare");
    let stakingVaultBankShareBefore = await bankShare.balanceOf(stakingVaultAddress);
    aliceBankShareBefore = await bankShare.balanceOf(aliceAddress);
    tx = await stakingVault.connect(alice).stake(ethers.parseUnits("15000"));
    await tx.wait();
    let stakingVaultBankShareAfter = await bankShare.balanceOf(stakingVaultAddress);
    aliceBankShareAfter = await bankShare.balanceOf(aliceAddress);
    let totalStakedAfter = await stakingVault.totalStaked();
    deltaRow("alice bankShare:", aliceBankShareBefore, aliceBankShareAfter);
    deltaRow("staking vault bankShare:", stakingVaultBankShareBefore, stakingVaultBankShareAfter);
    expect(
        aliceBankShareAfter < aliceBankShareBefore &&
        stakingVaultBankShareAfter > stakingVaultBankShareBefore &&
        stakingVaultBankShareAfter == totalStakedAfter,
        "deltas ok (alice -bankShare, staking vault +bankShare)",
        "unexpected deltas"
    )
    console.log("")

    console.log("[swap] dev swaps tokens a few more times to generate LP fees");
    devStablecoinBefore = await stablecoin.balanceOf(devAddress);
    devBankShareBefore = await bankShare.balanceOf(devAddress);
    poolStablecoinBefore = await stablecoin.balanceOf(POOL_MANAGER);
    poolBankShareBefore = await bankShare.balanceOf(POOL_MANAGER);
    await doSwap(dev, stablecoinAddress, bankShareAddress, "45000", hookAddress, swapHelper);
    await doSwap(dev, bankShareAddress, stablecoinAddress, "30000", hookAddress, swapHelper);
    devStablecoinAfter = await stablecoin.balanceOf(devAddress);
    devBankShareAfter = await bankShare.balanceOf(devAddress);
    poolStablecoinAfter = await stablecoin.balanceOf(POOL_MANAGER);
    poolBankShareAfter = await bankShare.balanceOf(POOL_MANAGER);
    deltaRow("pool stablecoin:", poolStablecoinBefore, poolStablecoinAfter);
    deltaRow("dev stablecoin:", devStablecoinBefore, devStablecoinAfter);
    deltaRow("pool bankShare:", poolBankShareBefore, poolBankShareAfter);
    deltaRow("dev bankShare:", devBankShareBefore, devBankShareAfter);
    expect(
        poolStablecoinAfter > poolStablecoinBefore &&
        poolBankShareAfter < poolBankShareBefore &&
        devStablecoinAfter < devStablecoinBefore &&
        devBankShareAfter > devBankShareBefore,
        "deltas ok (dev -stablecoin/+bankShare, pool +stablecoin/-bankShare)",
        "unexpected deltas"
    )
    console.log("");

    console.log("[harvest] alice calls harvestFees()");
    stablecoinSupplyBefore = await stablecoin.totalSupply();
    redeemableSupplyBefore = await bank.redeemableStablecoinSupply();
    let collateralRatioBefore = await bank.collateralRatio();
    let totalHarvestedBefore = await bank.totalHarvested();
    aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
    let stakingVaultStablecoinBefore = await stablecoin.balanceOf(stakingVaultAddress);
    let totalBurnedBefore = await bank.stablecoinBurnedByPolicy();
    let tokenIdBefore = await bank.tokenId();
    let [tickLowerBefore, tickUpperBefore, liquidityBefore] = await bank.getPositionInfo();
    tx = await bank.connect(alice).harvestFees();
    tx.wait();
    stablecoinSupplyAfter = await stablecoin.totalSupply();
    redeemableSupplyAfter = await bank.redeemableStablecoinSupply();
    let collateralRatioAfter = await bank.collateralRatio();
    let totalHarvestedAfter = await bank.totalHarvested();
    aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
    let stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
    let totalBurnedAfter = await bank.stablecoinBurnedByPolicy();
    let tokenIdAfter = await bank.tokenId();
    let [tickLowerAfter, tickUpperAfter, liquidityAfter] = await bank.getPositionInfo();
    deltaRow("total harvested:", totalHarvestedBefore, totalHarvestedAfter);
    deltaRow("amount burned:", totalBurnedBefore, totalBurnedAfter);
    deltaRow("alice stablecoin:", aliceStablecoinBefore, aliceStablecoinAfter);
    deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
    deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
    deltaRow("redeemable supply:", redeemableSupplyBefore, redeemableSupplyAfter);
    deltaRow("collateral ratio (bps):", collateralRatioBefore, collateralRatioAfter, false);
    deltaRow("LP tokenId:", tokenIdBefore, tokenIdAfter, false);
    deltaRow("LP tickLower:", tickLowerBefore, tickLowerAfter, false);
    deltaRow("LP tickUpper:", tickUpperBefore, tickUpperAfter, false);
    expect(
        tokenIdAfter > tokenIdBefore &&
        stablecoinSupplyAfter < stablecoinSupplyBefore &&
        // When token order is reversed, increasing price corresponds to decreasing ticks.
        tickLowerAfter < tickLowerBefore &&
        tickUpperAfter < tickUpperBefore &&
        stakingVaultStablecoinAfter > stakingVaultStablecoinBefore &&
        aliceStablecoinAfter > aliceStablecoinBefore,
        "caller rewarded; fees to vault; stablecoin burned; LP rebalanced",
        ""
    )
    console.log("");

    console.log("[claim] alice claims staking rewards");
    aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
    stakingVaultStablecoinBefore = await stablecoin.balanceOf(stakingVaultAddress);
    tx = await stakingVault.connect(alice).claim();
    receipt = await tx.wait();
    aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
    stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
    deltaRow("alice stablecoin:", aliceStablecoinBefore, aliceStablecoinAfter);
    deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
    expect(
        stakingVaultStablecoinAfter < stakingVaultStablecoinBefore &&
        aliceStablecoinAfter > aliceStablecoinBefore,
        "alice +stablecoin, staking vault -stablecoin",
        "claim unsuccessful"
    )
    console.log("");

    console.log("[set] lower target collateral ratio to 99%");
    let targetCollateralRatioBefore = await bank.targetCollateralRatioBps();
    tx = await bank.setTargetCollateralRatio(9900);
    await tx.wait();
    let targetCollateralRatioAfter = await bank.targetCollateralRatioBps();
    deltaRow("target ratio (bps):", targetCollateralRatioBefore, targetCollateralRatioAfter, false);
    expect(targetCollateralRatioAfter == 9900, "target ratio set", "");
    console.log("");

    console.log("[harvest] policy mint (overcollateralized, no fees generated since last harvest)");
    stablecoinSupplyBefore = await stablecoin.totalSupply();
    redeemableSupplyBefore = await bank.redeemableStablecoinSupply();
    totalHarvestedBefore = await bank.totalHarvested();
    collateralRatioBefore = await bank.collateralRatio();
    aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
    stakingVaultStablecoinBefore = await stablecoin.balanceOf(stakingVaultAddress);
    tokenIdBefore = await bank.tokenId();
    [tickLowerBefore, tickUpperBefore, liquidityBefore] = await bank.getPositionInfo();
    tx = await bank.connect(alice).harvestFees();
    tx.wait();
    stablecoinSupplyAfter = await stablecoin.totalSupply();
    redeemableSupplyAfter = await bank.redeemableStablecoinSupply();
    totalHarvestedAfter = await bank.totalHarvested();
    collateralRatioAfter = await bank.collateralRatio();
    aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
    stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
    tokenIdAfter = await bank.tokenId();
    [tickLowerAfter, tickUpperAfter, liquidityAfter] = await bank.getPositionInfo();
    row("fees accumulated:", fmt(totalHarvestedAfter - totalHarvestedBefore));
    deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
    deltaRow("redeemable supply:", redeemableSupplyBefore, redeemableSupplyAfter);
    row("target ratio (bps):", targetCollateralRatioAfter);
    row("minted to reach target:", fmt(stablecoinSupplyAfter - stablecoinSupplyBefore));
    deltaRow("collateral ratio (bps):", collateralRatioBefore, collateralRatioAfter, false);
    deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
    expect(
        stablecoinSupplyAfter > stablecoinSupplyBefore &&
        stakingVaultStablecoinAfter > stakingVaultStablecoinBefore &&
        collateralRatioAfter == targetCollateralRatioAfter,
        "overcollateralized; minted stablecoin to vault (policy)",
        "mint failed"
    )
    console.log("");
/*
  console.log("Dev burning MONA to test overcollateralization");
  console.log("Dev MONA balance before burn:", ethers.formatUnits(await stablecoin.balanceOf(devAddress)));
  tx = await stablecoin.connect(dev).burn(devAddress, ethers.parseUnits("30000"));
  receipt = await tx.wait();
  console.log("Dev MONA balance after burn:", ethers.formatUnits(await stablecoin.balanceOf(devAddress)));
  console.log("\n");
 */

    console.log("Alice testing overcollateralization rewards");
    console.log("Bank MONA balance before alice collecting:", ethers.formatUnits(await stablecoin.balanceOf(bankAddress)));
    console.log("Alice MONA balance before collecting:", ethers.formatUnits(await stablecoin.balanceOf(aliceAddress)));
    tx = await bank.connect(alice).harvestFees();
    tx = await stakingVault.connect(alice).claim();
    console.log("Bank MONA balance after alice collecting:", ethers.formatUnits(await stablecoin.balanceOf(bankAddress)));
    console.log("Alice MONA balance after collecting:", ethers.formatUnits(await stablecoin.balanceOf(aliceAddress)));
    console.log("Bank balance of LISA:", await bankShare.balanceOf(bankAddress));
    console.log("\n");

/*
  console.log("\nDev calling rebalance().");
  console.log("Current pool tick:", await bank.getPoolInfo());
  console.log("Token ID before rebalance:", await bank.token_id());
  [tick_lower, tick_upper, liquidity] = await bank.getPositionInfo();
  console.log("Position info before rebalance:", tick_lower, tick_upper, liquidity);
  tx = await bank.connect(alice).harvestFees();
  console.log("Token ID after rebalance:", await bank.token_id());
  [tick_lower, tick_upper, liquidity] = await bank.getPositionInfo();
  console.log("Position info after rebalance:", tick_lower, tick_upper, liquidity);
  console.log("Bank MONA balance after rebalance:", ethers.formatUnits(await stablecoin.balanceOf(bankAddress)));
  console.log("Bank LISA balance after rebalance:", ethers.formatUnits(await bankShare.balanceOf(bankAddress)));
*/

    console.log("Dev raising collateral requirement.");
    tx = await bank.connect(dev).setTargetCollateralRatio(15000); // 150%
    console.log("Dev donating 5000 MONA");
    console.log("stablecoin supply before donating:", ethers.formatUnits(await stablecoin.totalSupply()));
    tx = await bank.connect(dev).donate(ethers.parseUnits("5000"));
    console.log("stablecoin supply after donating:", ethers.formatUnits(await stablecoin.totalSupply()));
    console.log("alice claiming donated rewards.");
    console.log("Alice MONA balance before collecting:", ethers.formatUnits(await stablecoin.balanceOf(aliceAddress)));
    tx = await stakingVault.connect(alice).claim();
    console.log("Alice MONA balance after collecting:", ethers.formatUnits(await stablecoin.balanceOf(aliceAddress)));
    console.log("Bank balance of LISA:", await bankShare.balanceOf(bankAddress));
    console.log("\n");

    console.log("Alice spending 3000 MONA to buy LISA");
    console.log("Alice MONA balance before spend:", ethers.formatUnits(await stablecoin.balanceOf(aliceAddress)));
    await doSwap(alice, stablecoinAddress, bankShareAddress, "3000", hookAddress, swapHelper);
    console.log("Alice MONA balance after spend:", ethers.formatUnits(await stablecoin.balanceOf(aliceAddress)));
    console.log("Alice LISA balance after spend:", ethers.formatUnits(await bankShare.balanceOf(aliceAddress)));
    console.log("Bank balance of LISA:", await bankShare.balanceOf(bankAddress));
    console.log("\n");

    console.log("Alice calling harvest fees. some stablecoin should be burned, as we are below reserve requirement.");
    console.log("stablecoin supply before harvesting:", ethers.formatUnits(await stablecoin.totalSupply()));
    console.log("Current pool tick:", await bank.getPoolInfo());
    tx = await bank.connect(alice).harvestFees();
    console.log("stablecoin supply after harvesting:", ethers.formatUnits(await stablecoin.totalSupply()));
    console.log("Alice calling claim(). Alice should receive some rewards.");
    console.log("Alice MONA balance before claim:", ethers.formatUnits(await stablecoin.balanceOf(aliceAddress)));
    tx = await stakingVault.connect(alice).claim();
    console.log("Alice MONA balance after claim:", ethers.formatUnits(await stablecoin.balanceOf(aliceAddress)));
    console.log("Bank balance of LISA:", await bankShare.balanceOf(bankAddress));
    console.log("\n");

    console.log("Dev Spending 15,000 MONA for LISA to force another rebalance");
    await doSwap(dev, stablecoinAddress, bankShareAddress, "25000", hookAddress, swapHelper);
    console.log("Dev MONA balance:", ethers.formatUnits(await stablecoin.balanceOf(devAddress)));
    console.log("Dev LISA balance:", ethers.formatUnits(await bankShare.balanceOf(devAddress)));
    console.log("Current pool tick:", await bank.getPoolInfo());
    await wait();
    console.log("Alice calling harvestFees(), bank should rebalance.");
    console.log("Token ID before harvest:", await bank.tokenId());
    [tick_lower, tick_upper, liquidity] = await bank.getPositionInfo();
    console.log("Position info before harvest:", tick_lower, tick_upper, liquidity);
    console.log("Bank balance of MONA:", await stablecoin.balanceOf(bankAddress));
    console.log("Bank balance of LISA:", await bankShare.balanceOf(bankAddress));
    tx = await bank.connect(alice).harvestFees();
    console.log("Token ID after harvest:", await bank.tokenId());
    console.log("Bank balance of MONA:", await stablecoin.balanceOf(bankAddress));
    console.log("Bank balance of LISA:", await bankShare.balanceOf(bankAddress));
    [tick_lower, tick_upper, liquidity] = await bank.getPositionInfo();
    console.log("Position info after harvest:", tick_lower, tick_upper, liquidity);
    console.log("Current pool tick:", await bank.getPoolInfo());
    console.log("Bank balance of LISA:", await bankShare.balanceOf(bankAddress));
    console.log("\n");

/*
  console.log("Alice calling harvestFees(), bank should rebalance.");
  console.log("Token ID before harvest:", await bank.token_id());
  [tick_lower, tick_upper, liquidity] = await bank.getPositionInfo();
  console.log("Position info before harvest:", tick_lower, tick_upper, liquidity);
  console.log("Bank balance of MONA:", await stablecoin.balanceOf(bankAddress));
  console.log("Bank balance of LISA:", await bankShare.balanceOf(bankAddress));
  tx = await bank.connect(alice).harvestFees();
  console.log("Token ID after harvest:", await bank.token_id());
  console.log("Bank balance of MONA:", await stablecoin.balanceOf(bankAddress));
  console.log("Bank balance of LISA:", await bankShare.balanceOf(bankAddress));
  [tick_lower, tick_upper, liquidity] = await bank.getPositionInfo();
  console.log("Position info after harvest:", tick_lower, tick_upper, liquidity);
  console.log("Current pool tick:", await bank.getPoolInfo());
  console.log("Bank balance of LISA:", await bankShare.balanceOf(bankAddress));
  console.log("\n");
 */
    if (failed > 0) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

