# A T-Bill-Backed Stablecoin You Can Buy Stock In

A stablecoin protocol backed by tokenized U.S. Treasury bills, where anyone can buy equity in the protocol and earn yield from the underlying collateral.

**[Read the whitepaper](https://github.com/daren47/stablecoin-v0/blob/main/whitepaper.md)**

> **This is a research implementation.** Not audited, not production-ready, not deployed. Don't deploy it as-written.

---

## What it is

A stablecoin backed by tokenized T-bills, paired with a fixed-supply equity token. Equity holders stake their tokens and receive a share of all protocol revenue -- T-bill yield, liquidity pool fees, and mint/redemption fees. The protocol bootstraps itself with zero initial capital by minting both tokens into a Uniswap v4 liquidity pool that it owns.

---

## Quick start

### Prerequisites

* Node.js (>=18)
* npm (>=9)
* Docker
* An Ethereum RPC URL (e.g. from Alchemy or Infura)

### Tested with

* Node.js 18.x
* npm 10.x

### Setup

1. Clone and install:

```bash
git clone https://github.com/daren47/stablecoin-v0.git
cd stablecoin-v0
npm install
```

2. Create a `.env` file with your RPC URL:

```bash
cp .env.example .env
```

```
RPC_URL=your_rpc_url_here
```

3. Build and run the forked mainnet docker image:

```bash
npm run build-docker
npm run anvil
```

4. In another terminal:

```bash
npm test
```

This deploys the full contract system on forked mainnet and runs integration tests covering the complete protocol lifecycle -- minting, redemption, swaps, staking, fee harvesting, policy mints, and treasury operations.

---

## Repository structure

* `contracts/` -- Solidity contracts
* `scripts/` -- Deployment and integration tests
* `docker/` -- Docker configuration for reproducible dev environments

---

## Contact

I'm looking for work in the crypto/DeFi space -- protocol design, mechanism design, smart contract development.

Reach me at: darenjames47@gmail.com

---

## License

MIT
