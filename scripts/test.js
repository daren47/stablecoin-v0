const { expect, testResults, fmt, row, deltaRow, resetHardhat,
  deployContracts, doSwap, POOL_MANAGER } = require("./test-utils.js");

const { ethers, network } = require("hardhat");
const { MaxUint256 } = require("ethers");

async function main() {
    await resetHardhat();
    let [dev, devAddress, alice, aliceAddress, bank, bankAddress,
        stablecoin, stablecoinAddress, bankShare, bankShareAddress,
        stakingVault, stakingVaultAddress, treasuryVault, treasuryVaultAddress,
        swapHelper, swapHelperAddress, hookAddress, tbtc] = await deployContracts();

    console.log("[oracle] check tBTC price");
    const tbtcPrice = await bank.getPrice();
    row("tBTC price:", ethers.formatUnits(tbtcPrice));
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
    await doSwap(dev, bankShareAddress, stablecoinAddress, "20000", hookAddress, swapHelper);
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
    let treasuryVaultStablecoinBefore = await stablecoin.balanceOf(treasuryVaultAddress);
    let totalBurnedBefore = await bank.stablecoinBurnedByPolicy();
    tx = await bank.connect(alice).harvestFees();
    tx.wait();
    stablecoinSupplyAfter = await stablecoin.totalSupply();
    redeemableSupplyAfter = await bank.redeemableStablecoinSupply();
    let collateralRatioAfter = await bank.collateralRatio();
    let totalHarvestedAfter = await bank.totalHarvested();
    aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
    let stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
    let treasuryVaultStablecoinAfter = await stablecoin.balanceOf(treasuryVaultAddress);
    let totalBurnedAfter = await bank.stablecoinBurnedByPolicy();
    deltaRow("total harvested:", totalHarvestedBefore, totalHarvestedAfter);
    deltaRow("amount burned:", totalBurnedBefore, totalBurnedAfter);
    deltaRow("alice stablecoin:", aliceStablecoinBefore, aliceStablecoinAfter);
    deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
    deltaRow("treasury vault stablecoin:", treasuryVaultStablecoinBefore, treasuryVaultStablecoinAfter);
    deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
    deltaRow("redeemable supply:", redeemableSupplyBefore, redeemableSupplyAfter);
    deltaRow("collateral ratio (bps):", collateralRatioBefore, collateralRatioAfter, false);
    expect(
        stablecoinSupplyAfter < stablecoinSupplyBefore &&
        stakingVaultStablecoinAfter > stakingVaultStablecoinBefore &&
        treasuryVaultStablecoinAfter > treasuryVaultStablecoinBefore &&
        aliceStablecoinAfter > aliceStablecoinBefore,
        "caller rewarded; fees to vaults; stablecoin burned",
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

    console.log("[stake] dev staking bankShare");
    stakingVaultBankShareBefore = await bankShare.balanceOf(stakingVaultAddress);
    devBankShareBefore = await bankShare.balanceOf(devAddress);
    tx = await stakingVault.connect(dev).stake(ethers.parseUnits("2500"));
    await tx.wait();
    stakingVaultBankShareAfter = await bankShare.balanceOf(stakingVaultAddress);
    devBankShareAfter = await bankShare.balanceOf(devAddress);
    deltaRow("dev bankShare:", devBankShareBefore, devBankShareAfter);
    deltaRow("staking vault bankShare:", stakingVaultBankShareBefore, stakingVaultBankShareAfter);
    expect(
        devBankShareAfter < devBankShareBefore &&
        stakingVaultBankShareAfter > stakingVaultBankShareBefore,
        "deltas ok (dev -bankShare, staking vault +bankShare)",
        "unexpected deltas"
    )
    console.log("")

    console.log("[set] lower target collateral ratio to 99%");
    let targetCollateralRatioBefore = await bank.targetCollateralRatioBps();
    tx = await bank.setTargetCollateralRatio(9900);
    await tx.wait();
    let targetCollateralRatioAfter = await bank.targetCollateralRatioBps();
    deltaRow("target ratio (bps):", targetCollateralRatioBefore, targetCollateralRatioAfter, false);
    expect(targetCollateralRatioAfter == 9900, "target ratio set", "");
    console.log("");

    console.log("[harvest] policy mint (overcollateralized)");
    stablecoinSupplyBefore = await stablecoin.totalSupply();
    redeemableSupplyBefore = await bank.redeemableStablecoinSupply();
    totalHarvestedBefore = await bank.totalHarvested();
    collateralRatioBefore = await bank.collateralRatio();
    aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
    stakingVaultStablecoinBefore = await stablecoin.balanceOf(stakingVaultAddress);
    treasuryVaultStablecoinBefore = await stablecoin.balanceOf(treasuryVaultAddress);
    tx = await bank.connect(alice).harvestFees();
    tx.wait();
    stablecoinSupplyAfter = await stablecoin.totalSupply();
    redeemableSupplyAfter = await bank.redeemableStablecoinSupply();
    totalHarvestedAfter = await bank.totalHarvested();
    collateralRatioAfter = await bank.collateralRatio();
    aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
    stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
    treasuryVaultStablecoinAfter = await stablecoin.balanceOf(treasuryVaultAddress);
    deltaRow("total harvested:", totalHarvestedBefore, totalHarvestedAfter);
    deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
    deltaRow("redeemable supply:", redeemableSupplyBefore, redeemableSupplyAfter);
    row("target ratio (bps):", targetCollateralRatioAfter);
    row("minted to reach target:", fmt(stablecoinSupplyAfter - stablecoinSupplyBefore));
    deltaRow("collateral ratio (bps):", collateralRatioBefore, collateralRatioAfter, false);
    deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
    deltaRow("treasury vault stablecoin:", treasuryVaultStablecoinBefore, treasuryVaultStablecoinAfter);
    expect(
        stablecoinSupplyAfter > stablecoinSupplyBefore &&
        stakingVaultStablecoinAfter > stakingVaultStablecoinBefore &&
        stakingVaultStablecoinAfter > stakingVaultStablecoinBefore &&
        collateralRatioAfter == targetCollateralRatioAfter,
        "overcollateralized; minted stablecoin to vaults (policy)",
        "mint failed"
    )
    console.log("");

    console.log("[claim] dev claims staking rewards");
    devStablecoinBefore = await stablecoin.balanceOf(devAddress);
    stakingVaultStablecoinBefore = await stablecoin.balanceOf(stakingVaultAddress);
    tx = await stakingVault.connect(dev).claim();
    await tx.wait();
    devStablecoinAfter = await stablecoin.balanceOf(devAddress);
    stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
    deltaRow("dev stablecoin:", devStablecoinBefore, devStablecoinAfter);
    deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
    expect(
        stakingVaultStablecoinAfter < stakingVaultStablecoinBefore &&
        devStablecoinAfter > devStablecoinBefore,
        "dev +stablecoin, staking vault -stablecoin",
        "claim unsuccessful"
    );
    console.log("");

    console.log("[return] treasury vault returning stablecoin to bank");
    stablecoinSupplyBefore = await stablecoin.totalSupply();
    treasuryVaultStablecoinBefore = await stablecoin.balanceOf(treasuryVaultAddress);
    stakingVaultStablecoinBefore = await stablecoin.balanceOf(stakingVaultAddress);
    tx = await treasuryVault.connect(dev).returnToBank(treasuryVaultStablecoinBefore);
    await tx.wait();
    stablecoinSupplyAfter = await stablecoin.totalSupply();
    treasuryVaultStablecoinAfter = await stablecoin.balanceOf(treasuryVaultAddress);
    stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
    deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
    deltaRow("treasury vault stablecoin:", treasuryVaultStablecoinBefore, treasuryVaultStablecoinAfter);
    deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
    expect(
        stakingVaultStablecoinAfter > stakingVaultStablecoinBefore &&
        treasuryVaultStablecoinAfter < treasuryVaultStablecoinBefore &&
        stablecoinSupplyAfter < stablecoinSupplyBefore,
        "stablecoin burned; stablecoin sent to staking vault",
        ""
    );
    console.log("");

    console.log("[claim] dev claims staking rewards");
    devStablecoinBefore = await stablecoin.balanceOf(devAddress);
    stakingVaultStablecoinBefore = await stablecoin.balanceOf(stakingVaultAddress);
    tx = await stakingVault.connect(dev).claim();
    await tx.wait();
    devStablecoinAfter = await stablecoin.balanceOf(devAddress);
    stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
    deltaRow("dev stablecoin:", devStablecoinBefore, devStablecoinAfter);
    deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
    expect(
        stakingVaultStablecoinAfter < stakingVaultStablecoinBefore &&
        devStablecoinAfter > devStablecoinBefore,
        "dev +stablecoin, staking vault -stablecoin",
        "claim unsuccessful"
    );
    console.log("");

    console.log("[claim] alice claims staking rewards");
    aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
    stakingVaultStablecoinBefore = await stablecoin.balanceOf(stakingVaultAddress);
    tx = await stakingVault.connect(alice).claim();
    await tx.wait();
    aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
    stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
    deltaRow("alice stablecoin:", aliceStablecoinBefore, aliceStablecoinAfter);
    deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
    expect(
        stakingVaultStablecoinAfter < stakingVaultStablecoinBefore &&
        aliceStablecoinAfter > aliceStablecoinBefore,
        "alice +stablecoin, staking vault -stablecoin",
        "claim unsuccessful"
    );
    console.log("");

    console.log("[donate] dev donates to the protocol");
    stablecoinSupplyBefore = await stablecoin.totalSupply();
    devStablecoinBefore = await stablecoin.balanceOf(devAddress);
    stakingVaultStablecoinBefore = await stablecoin.balanceOf(stakingVaultAddress);
    treasuryVaultStablecoinBefore = await stablecoin.balanceOf(treasuryVaultAddress);
    tx = await bank.connect(dev).donate(ethers.parseUnits("20000"));
    await tx.wait();
    stablecoinSupplyAfter = await stablecoin.totalSupply();
    devStablecoinAfter = await stablecoin.balanceOf(devAddress);
    stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
    treasuryVaultStablecoinAfter = await stablecoin.balanceOf(treasuryVaultAddress);
    deltaRow("dev stablecoin:", devStablecoinBefore, devStablecoinAfter);
    deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
    deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
    deltaRow("treasury vault stablecoin:", treasuryVaultStablecoinBefore, treasuryVaultStablecoinAfter);
    expect(
        devStablecoinAfter < devStablecoinBefore &&
        stakingVaultStablecoinAfter > stakingVaultStablecoinBefore &&
        treasuryVaultStablecoinAfter > treasuryVaultStablecoinBefore,
        "stablecoin sent from dev to staking vault and treasury vault",
        ""
    );
    console.log("");

    console.log("[stake] dev staking more bankShare");
    devStablecoinBefore = await stablecoin.balanceOf(devAddress);
    stakingVaultBankShareBefore = await bankShare.balanceOf(stakingVaultAddress);
    stakingVaultStablecoinBefore = await stablecoin.balanceOf(stakingVaultAddress);
    devBankShareBefore = await bankShare.balanceOf(devAddress);
    tx = await stakingVault.connect(dev).stake(ethers.parseUnits("100"));
    await tx.wait();
    devStablecoinAfter = await stablecoin.balanceOf(devAddress);
    stakingVaultBankShareAfter = await bankShare.balanceOf(stakingVaultAddress);
    stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
    devBankShareAfter = await bankShare.balanceOf(devAddress);
    deltaRow("dev bankShare:", devBankShareBefore, devBankShareAfter);
    deltaRow("dev stablecoin:", devStablecoinBefore, devStablecoinAfter);
    deltaRow("staking vault bankShare:", stakingVaultBankShareBefore, stakingVaultBankShareAfter);
    deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
    expect(
        devBankShareAfter < devBankShareBefore &&
        devStablecoinAfter > devStablecoinBefore &&
        stakingVaultBankShareAfter > stakingVaultBankShareBefore &&
        stakingVaultStablecoinAfter < stakingVaultStablecoinBefore,
        "stake() triggered claim(), dev +stablecoin, staking vault -stablecoin",
        "unexpected deltas"
    )
    console.log("")

    console.log("[claim] dev calls claim() again (no rewards accumulated since last claim)");
    devStablecoinBefore = await stablecoin.balanceOf(devAddress);
    stakingVaultStablecoinBefore = await stablecoin.balanceOf(stakingVaultAddress);
    tx = await stakingVault.connect(dev).claim();
    await tx.wait();
    devStablecoinAfter = await stablecoin.balanceOf(devAddress);
    stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
    deltaRow("dev stablecoin:", devStablecoinBefore, devStablecoinAfter);
    deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
    expect(
        stakingVaultStablecoinAfter == stakingVaultStablecoinBefore &&
        devStablecoinAfter == devStablecoinBefore,
        "dev received no stablecoin",
        "claim unsuccessful"
    );
    console.log("");

    testResults();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

