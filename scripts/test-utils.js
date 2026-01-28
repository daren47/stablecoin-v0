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
async function doSwap(sender, tokenIn, tokenOut, amount, hookAddress, swapHelper, fmt=true) {
    if (fmt) {
        amount = ethers.parseUnits(amount);
    }
    let tx = await swapHelper.connect(sender).swapTokens(tokenIn, tokenOut, hookAddress, amount);
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

function fmt(num, decimals = 18, displayDecimals = 4) {
  const s = ethers.formatUnits(num, decimals);
  const [i, f = ""] = s.split(".");
  return f
    ? `${i}.${f.slice(0, displayDecimals)}`
    : i;
}

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

function testResults() {
    return [checks, passed, failed];
}

async function resetHardhat() {
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
}

async function deployContracts() {

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

  const tbtcAddress = "0x18084fbA666a33d37592fA2633fD49a74DD93a88".toLowerCase(); // mainnet tBTC
  const tbtcHolder = "0x466C71131278ad54C555489BbfbdAC37E838f99C".toLowerCase();

  await network.provider.send("hardhat_setBalance", [
    tbtcHolder,
    ethers.toBeHex(ethers.parseEther("10")),
  ]);

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [tbtcHolder],
  });
  const whaleSigner = await ethers.getSigner(tbtcHolder);

  const tbtc = await ethers.getContractAt(
    [
      "function balanceOf(address) view returns (uint256)",
      "function decimals() view returns (uint8)",
      "function transfer(address to, uint256 amount) returns (bool)",
      "function transferFrom(address from, address to, uint256 amount) returns (bool)",
      "function approve(address spender, uint256 amount) returns (bool)",
      "function allowance(address owner, address spender) view returns (uint256)"
    ],
    tbtcAddress
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

  swapHelperAddress = await swapHelper.getAddress();

  await stablecoin.connect(dev).approve(swapHelperAddress, MaxUint256);
  await bankShare.connect(dev).approve(swapHelperAddress, MaxUint256);
  await stablecoin.connect(alice).approve(swapHelperAddress, MaxUint256);
  await bankShare.connect(alice).approve(swapHelperAddress, MaxUint256);

  return [dev, devAddress, alice, aliceAddress,
    bank, bankAddress, stablecoin, stablecoinAddress,
    bankShare, bankShareAddress, stakingVault, stakingVaultAddress,
    swapHelper, swapHelperAddress, hookAddress, tbtc
  ];
}

module.exports = {
  expect,
  testResults,
  row,
  deltaRow,
  resetHardhat,
  deployContracts,
  doSwap,
  POOL_MANAGER
}
