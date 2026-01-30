const { expect, testResults, fmt, row, deltaRow, resetHardhat,
  deployContracts, doSwap, POOL_MANAGER } = require("./test-utils.js");

const { ethers } = require("hardhat");
const { MaxUint256 } = require("ethers");

const raw = process.env.BURNRATE || "5000";

const burnRate = Number.parseInt(raw, 10);
if (!Number.isFinite(burnRate) || String(burnRate) !== raw || burnRate < 0 || burnRate > 10000) {
  console.error(`Invalid integer argument: ${raw}`);
  process.exit(1);
}

console.log("Running phantom liquidity test with burn rate (basis points):", burnRate);
console.log("");
console.log("To set burn rate, run this test with:");
console.log("  BURNRATE=<N> npm run phantom-liquidity");
console.log("where N is burn rate in basis points (0->10000)\n");

async function main() {
  await resetHardhat();
  let [dev, devAddress, alice, aliceAddress, bank, bankAddress,
    stablecoin, stablecoinAddress, bankShare, bankShareAddress,
    stakingVault, stakingVaultAddress, swapHelper, swapHelperAddress,
    hookAddress, tbtc] = await deployContracts();

  console.log("[mint] alice minting stablecoin")
  let stablecoinSupplyBefore = await stablecoin.totalSupply();
  let redeemableSupplyBefore = await bank.redeemableStablecoinSupply();
  let bankTbtcBefore = await tbtc.balanceOf(bankAddress);
  let aliceTbtcBefore = await tbtc.balanceOf(aliceAddress);
  let aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
  tx = await bank.connect(alice).mintStablecoin(ethers.parseUnits("2000.00", 18), MaxUint256, MaxUint256);
  await tx.wait();
  let stablecoinSupplyAfter = await stablecoin.totalSupply();
  let redeemableSupplyAfter = await bank.redeemableStablecoinSupply();
  let bankTbtcAfter = await tbtc.balanceOf(bankAddress);
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

  console.log("[swap] alice buys bankShare");
  stablecoinSupplyBefore = await stablecoin.totalSupply();
  redeemableSupplyBefore = await bank.redeemableStablecoinSupply();
  aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
  let aliceBankShareBefore = await bankShare.balanceOf(aliceAddress);
  let poolStablecoinBefore = await stablecoin.balanceOf(POOL_MANAGER);
  let poolBankShareBefore = await bankShare.balanceOf(POOL_MANAGER);
  await doSwap(alice, stablecoinAddress, bankShareAddress, "1000", hookAddress, swapHelper);
  stablecoinSupplyAfter = await stablecoin.totalSupply();
  redeemableSupplyAfter = await bank.redeemableStablecoinSupply();
  aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
  let aliceBankShareAfter = await bankShare.balanceOf(aliceAddress);
  let poolStablecoinAfter = await stablecoin.balanceOf(POOL_MANAGER);
  let poolBankShareAfter = await bankShare.balanceOf(POOL_MANAGER);
  deltaRow("pool stablecoin:", poolStablecoinBefore, poolStablecoinAfter);
  deltaRow("alice stablecoin:", aliceStablecoinBefore, aliceStablecoinAfter);
  deltaRow("pool bankShare:", poolBankShareBefore, poolBankShareAfter);
  deltaRow("alice bankShare:", aliceBankShareBefore, aliceBankShareAfter);
  deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
  deltaRow("redeemable supply:", redeemableSupplyBefore, redeemableSupplyAfter);
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
  tx = await stakingVault.connect(alice).stake(aliceBankShareBefore);
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

  console.log("[swap] alice swaps stablecoin <-> bankShare back and forth many times");
  stablecoinSupplyBefore = await stablecoin.totalSupply();
  redeemableSupplyBefore = await bank.redeemableStablecoinSupply();
  aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
  aliceBankShareBefore = await bankShare.balanceOf(aliceAddress);
  poolStablecoinBefore = await stablecoin.balanceOf(POOL_MANAGER);
  poolBankShareBefore = await bankShare.balanceOf(POOL_MANAGER);
  for (let i = 0; i < 50; i++) {
    let currentStablecoin = await stablecoin.balanceOf(aliceAddress);
    await doSwap(alice, stablecoinAddress, bankShareAddress, currentStablecoin, hookAddress, swapHelper, false);
    let currentBankShare = await bankShare.balanceOf(aliceAddress);
    await doSwap(alice, bankShareAddress, stablecoinAddress, currentBankShare, hookAddress, swapHelper, false);
  }
  aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
  aliceBankShareAfter = await bankShare.balanceOf(aliceAddress);
  poolStablecoinAfter = await stablecoin.balanceOf(POOL_MANAGER);
  poolBankShareAfter = await bankShare.balanceOf(POOL_MANAGER);
  stablecoinSupplyAfter = await stablecoin.totalSupply();
  redeemableSupplyAfter = await bank.redeemableStablecoinSupply();
  deltaRow("pool stablecoin:", poolStablecoinBefore, poolStablecoinAfter);
  deltaRow("alice stablecoin:", aliceStablecoinBefore, aliceStablecoinAfter);
  deltaRow("pool bankShare:", poolBankShareBefore, poolBankShareAfter);
  deltaRow("alice bankShare:", aliceBankShareBefore, aliceBankShareAfter);
  deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
  deltaRow("redeemable supply:", redeemableSupplyBefore, redeemableSupplyAfter);
  expect(
    // alice is swapping all her stablecoin for all her bankShare, back and forth over and over,
    // so the pool should end up with more stablecoin (due to fees) and the same amount of
    // bankShare (since alice swaps all if it back in), while alice ends up with less stablecoin
    // (due to fees) and the the same amount of bankShare as she started with: 0.
    poolStablecoinAfter > poolStablecoinBefore &&
    poolBankShareAfter == poolBankShareBefore &&
    aliceStablecoinAfter < aliceStablecoinBefore &&
    aliceBankShareAfter == aliceBankShareBefore,
    "alice loses stablecoin to the pool due to tx fees",
    "unexpected deltas"
  )
  console.log("");

  console.log("[set] burn rate to " + burnRate + " basis points");
  let burnRateBefore = await bank.stablecoinBurnRatioBps();
  tx = await bank.setStablecoinBurnRatio(burnRate);
  await tx.wait();
  let burnRateAfter = await bank.stablecoinBurnRatioBps();
  deltaRow("burn rate (bps):", burnRateBefore, burnRateAfter, false);
  expect(burnRateAfter == burnRate, "burn rate set", "");
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
  expect(
    collateralRatioAfter >= collateralRatioBefore,
    "collateral after >= collateral before",
    ""
  )
  console.log("");

  console.log("[unstake] alice unstakes all her bankShare");
  let totalStakedBefore = await stakingVault.totalStaked();
  stakingVaultBankShareBefore = await bankShare.balanceOf(stakingVaultAddress);
  stakingVaultStablecoinBefore = await stablecoin.balanceOf(stakingVaultAddress);
  aliceBankShareBefore = await bankShare.balanceOf(aliceAddress);
  aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
  tx = await stakingVault.connect(alice).unstake(stakingVaultBankShareBefore);
  await tx.wait();
  totalStakedAfter = await stakingVault.totalStaked();
  stakingVaultBankShareAfter = await bankShare.balanceOf(stakingVaultAddress);
  stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
  aliceBankShareAfter = await bankShare.balanceOf(aliceAddress);
  aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
  deltaRow("total staked:", totalStakedBefore, totalStakedAfter);
  deltaRow("alice bankShare:", aliceBankShareBefore, aliceBankShareAfter);
  deltaRow("alice stablecoin:", aliceStablecoinBefore, aliceStablecoinAfter);
  deltaRow("staking vault bankShare:", stakingVaultBankShareBefore, stakingVaultBankShareAfter);
  deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
  expect(
    aliceBankShareAfter > aliceBankShareBefore &&
    aliceStablecoinAfter >= aliceStablecoinBefore &&
    stakingVaultBankShareAfter < stakingVaultBankShareBefore &&
    stakingVaultStablecoinAfter <= stakingVaultStablecoinBefore,
    "bankShare and accumulated stablecoin (if any) removed from staking vault and sent to alice",
    "unexpected deltas"
  )
  console.log("")

  console.log("[swap] alice sells all her bankShare");
  aliceBankShareBefore = await bankShare.balanceOf(aliceAddress);
  aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
  poolStablecoinBefore = await stablecoin.balanceOf(POOL_MANAGER);
  poolBankShareBefore = await bankShare.balanceOf(POOL_MANAGER);
  stablecoinSupplyBefore = await stablecoin.totalSupply();
  redeemableSupplyBefore = await bank.redeemableStablecoinSupply();
  await doSwap(alice, bankShareAddress, stablecoinAddress, aliceBankShareBefore, hookAddress, swapHelper, false);
  aliceBankShareAfter = await bankShare.balanceOf(aliceAddress);
  aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
  poolStablecoinAfter = await stablecoin.balanceOf(POOL_MANAGER);
  poolBankShareAfter = await bankShare.balanceOf(POOL_MANAGER);
  stablecoinSupplyAfter = await stablecoin.totalSupply();
  redeemableSupplyAfter = await bank.redeemableStablecoinSupply();
  deltaRow("alice bank share:", aliceBankShareBefore, aliceBankShareAfter);
  deltaRow("alice stablecoin:", aliceStablecoinBefore, aliceStablecoinAfter);
  deltaRow("pool stablecoin:", poolStablecoinBefore, poolStablecoinAfter);
  deltaRow("pool bank share:", poolBankShareBefore, poolBankShareAfter);
  deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
  deltaRow("redeemable supply:", redeemableSupplyBefore, redeemableSupplyAfter);
  expect(
    poolStablecoinAfter > poolBankShareAfter &&
    aliceStablecoinAfter < redeemableSupplyAfter,
    "initial liquidity still locked in pool, redeemableSupply > alice stablecoin balance",
    ""
  )
  console.log();

  console.log("[harvest] alice calls harvestFees(); nothing is staked so fees should all be burned");
  stablecoinSupplyBefore = await stablecoin.totalSupply();
  redeemableSupplyBefore = await bank.redeemableStablecoinSupply();
  collateralRatioBefore = await bank.collateralRatio();
  totalHarvestedBefore = await bank.totalHarvested();
  aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
  stakingVaultStablecoinBefore = await stablecoin.balanceOf(stakingVaultAddress);
  totalBurnedBefore = await bank.stablecoinBurnedByPolicy();
  tokenIdBefore = await bank.tokenId();
  [tickLowerBefore, tickUpperBefore, liquidityBefore] = await bank.getPositionInfo();
  tx = await bank.connect(alice).harvestFees();
  tx.wait();
  stablecoinSupplyAfter = await stablecoin.totalSupply();
  redeemableSupplyAfter = await bank.redeemableStablecoinSupply();
  collateralRatioAfter = await bank.collateralRatio();
  totalHarvestedAfter = await bank.totalHarvested();
  aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
  stakingVaultStablecoinAfter = await stablecoin.balanceOf(stakingVaultAddress);
  totalBurnedAfter = await bank.stablecoinBurnedByPolicy();
  tokenIdAfter = await bank.tokenId();
  [tickLowerAfter, tickUpperAfter, liquidityAfter] = await bank.getPositionInfo();
  deltaRow("total harvested:", totalHarvestedBefore, totalHarvestedAfter);
  deltaRow("amount burned:", totalBurnedBefore, totalBurnedAfter);
  deltaRow("alice stablecoin:", aliceStablecoinBefore, aliceStablecoinAfter);
  deltaRow("staking vault stablecoin:", stakingVaultStablecoinBefore, stakingVaultStablecoinAfter);
  deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
  deltaRow("redeemable supply:", redeemableSupplyBefore, redeemableSupplyAfter);
  deltaRow("collateral ratio (bps):", collateralRatioBefore, collateralRatioAfter, false);
  expect(
    stablecoinSupplyAfter < stablecoinSupplyBefore &&
    stakingVaultStablecoinAfter == stakingVaultStablecoinBefore,
    "no fees to vault; stablecoin burned",
    ""
  )
  console.log("");

  console.log("[redeem] alice redeems all her stablecoin");
  aliceStablecoinBefore = await stablecoin.balanceOf(aliceAddress);
  aliceTbtcBefore = await tbtc.balanceOf(aliceAddress);
  stablecoinSupplyBefore = await stablecoin.totalSupply();
  redeemableSupplyBefore = await bank.redeemableStablecoinSupply();
  poolStablecoinBefore = await stablecoin.balanceOf(POOL_MANAGER);
  poolBankShareBefore = await bankShare.balanceOf(POOL_MANAGER);
  collateralRatioBefore = await bank.collateralRatio();
  let valueOfCollateralBefore = await bank.valueOfCollateral();
  let collateralBefore = await tbtc.balanceOf(bankAddress);
  tx = await bank.connect(alice).redeemStablecoin(aliceStablecoinBefore, 0, MaxUint256);
  await tx.wait();
  aliceStablecoinAfter = await stablecoin.balanceOf(aliceAddress);
  aliceTbtcAfter = await tbtc.balanceOf(aliceAddress);
  stablecoinSupplyAfter = await stablecoin.totalSupply();
  redeemableSupplyAfter = await bank.redeemableStablecoinSupply();
  poolStablecoinAfter = await stablecoin.balanceOf(POOL_MANAGER);
  poolBankShareAfter = await bankShare.balanceOf(POOL_MANAGER);
  collateralRatioAfter = await bank.collateralRatio();
  let valueOfCollateralAfter = await bank.valueOfCollateral();
  let collateralAfter = await tbtc.balanceOf(bankAddress);
  let initialStablecoinSupply = await bank.TOTAL_SHARE_SUPPLY();
  row("initial stablecoin supply:", fmt(initialStablecoinSupply));
  deltaRow("stablecoin supply:", stablecoinSupplyBefore, stablecoinSupplyAfter);
  deltaRow("pool stablecoin:", poolStablecoinBefore, poolStablecoinAfter);
  deltaRow("pool bank share:", poolBankShareBefore, poolBankShareAfter);
  deltaRow("alice stablecoin:", aliceStablecoinBefore, aliceStablecoinAfter);
  deltaRow("alice tBTC:", aliceTbtcBefore, aliceTbtcAfter);
  deltaRow("collateral value (tbtc):", collateralBefore, collateralAfter);
  deltaRow("collateral value (usd):", valueOfCollateralBefore, valueOfCollateralAfter);
  deltaRow("redeemable supply:", redeemableSupplyBefore, redeemableSupplyAfter);
  deltaRow("collateral ratio:", collateralRatioBefore, collateralRatioAfter, false);
  expect(poolStablecoinAfter >= initialStablecoinSupply,
      "initial liquidity still locked",
      "initial liquidity removed from pool"
  );
  console.log("");

  testResults();

}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
