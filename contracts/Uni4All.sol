// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// uniswap v4 universal router
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";

// uniswap v4 core
import {IPoolManager, ModifyLiquidityParams} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

// uniswap v4 periphery
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "@uniswap/v4-periphery/lib/permit2/src/interfaces/IAllowanceTransfer.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

library Uni4All {
    using StateLibrary for IPoolManager;

    IUniversalRouter public constant ROUTER = IUniversalRouter(0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af);
    IPoolManager public constant POOL_MANAGER = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    IPositionManager public constant POSITION_MANAGER = IPositionManager(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e);
    IAllowanceTransfer constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    function approveRouter(address token) internal {
        IERC20(token).approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(token, address(ROUTER), type(uint160).max, type(uint48).max);
    }

    function approvePositionManager(address token) internal {
        IERC20(token).approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(token, address(POSITION_MANAGER), type(uint160).max, type(uint48).max);
    }

    function approvePoolManager(address token) internal {
        IERC20(token).approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(token, address(POOL_MANAGER), type(uint160).max, type(uint48).max);
    }

    // assumes already approved PERMIT2 and position manager
    function addLiquidity(
        PoolKey memory poolKey,
        uint128 amount0,
        uint128 amount1,
        int24 tickLower,
        int24 tickUpper
    ) internal returns (uint256 tokenId) {
        (uint160 sqrtPriceX96, , , ) = POOL_MANAGER.getSlot0(poolKey.toId());
        uint160 sqrtPriceX96A = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtPriceX96B = TickMath.getSqrtPriceAtTick(tickUpper);

        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            sqrtPriceX96A,
            sqrtPriceX96B,
            amount0,
            amount1
        );

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);

        params[0] = abi.encode(
            poolKey,
            tickLower,
            tickUpper,
            liq,
            amount0,
            amount1,
            // internal library function, so address(this) is the contract using the library
            address(this),
            ""
        );
        params[1] = abi.encode(poolKey.currency0, poolKey.currency1);

        tokenId = POSITION_MANAGER.nextTokenId();
        POSITION_MANAGER.modifyLiquidities(
            abi.encode(actions, params),
            block.timestamp + 60
        );
    }

    function initializePool(
        IERC20 token0,
        IERC20 token1,
        uint24 poolFee,
        int24 tickSpacing,
        address poolHooks,
        uint160 startingPrice
    ) internal returns (PoolKey memory poolKey) {
        if (address(token0) > address(token1)) {
            (token0, token1) = (token1, token0);
        }

        poolKey = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: poolFee,
            tickSpacing: tickSpacing,
            hooks: IHooks(poolHooks)
        });

        POOL_MANAGER.initialize(poolKey, startingPrice);
    }

    function initializePool(PoolKey memory poolKey, uint160 startingPrice) public {
        POOL_MANAGER.initialize(poolKey, startingPrice);
    }

    // helper for swapTokens that builds the PoolKey for you
    function swapTokens(
        address tokenIn,
        address tokenOut,
        uint128 amount,
        uint24 fee,
        int24 tickSpacing,
        address poolHooks
    ) internal returns (uint256) {
        address token0 = tokenIn;
        address token1 = tokenOut;
        if (tokenIn > tokenOut) {
            token0 = tokenOut;
            token1 = tokenIn;
        }

        PoolKey memory poolKey = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(poolHooks)
        });

        return swapTokens(tokenIn, tokenOut, amount, poolKey);
    }

    function swapTokens(
        address tokenIn,
        address tokenOut,
        uint128 amount,
        PoolKey memory poolKey
    ) internal returns (uint256) {
        address token0 = tokenIn;
        address token1 = tokenOut;
        bool zeroForOne = true;

        if (tokenIn > tokenOut) {
            token0 = tokenOut;
            token1 = tokenIn;
            zeroForOne = false;
        }

        // In this library we're not worrying about minAmountOut.
        return swapExactInputSingle(poolKey, amount, 0, zeroForOne);
    }

    function swapExactInputSingle(
        PoolKey memory key,
        uint128 amountIn,
        uint128 minAmountOut,
        bool zeroForOne
    ) internal returns (uint256 amountOut) {
        // Encode the Universal Router command
        bytes memory commands = abi.encodePacked(uint8(Commands.V4_SWAP));
        bytes[] memory inputs = new bytes[](1);

        // Encode V4Router actions
        bytes memory actions = abi.encodePacked(
            uint8(Actions.SWAP_EXACT_IN_SINGLE),
            uint8(Actions.SETTLE_ALL),
            uint8(Actions.TAKE_ALL)
        );

        // Prepare parameters for each action
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                hookData: bytes("")
            })
        );

        uint256 balanceBeforeSwap;
        if (zeroForOne) {
            params[1] = abi.encode(key.currency0, amountIn);
            params[2] = abi.encode(key.currency1, minAmountOut);
            balanceBeforeSwap = key.currency1.balanceOf(address(this));
        } else {
            params[1] = abi.encode(key.currency1, amountIn);
            params[2] = abi.encode(key.currency0, minAmountOut);
            balanceBeforeSwap = key.currency0.balanceOf(address(this));
        }

        // Combine actions and params into inputs
        inputs[0] = abi.encode(actions, params);

        // Execute the swap
        uint256 deadline = block.timestamp + 20;
        ROUTER.execute(commands, inputs, deadline);

        // Verify and return the output amount
        uint256 balanceAfterSwap;
        if (zeroForOne) {
            balanceAfterSwap = key.currency1.balanceOf(address(this));
        } else {
            balanceAfterSwap = key.currency0.balanceOf(address(this));
        }

        // it's probably invariant that balanceAfterSwap >= balanceBeforeSwap but it
        // doesn't hurt to check for it. If you're confident it's invariant you could
        // remove this require.
        require(balanceAfterSwap >= balanceBeforeSwap, "Insufficient output amount");

        amountOut = balanceAfterSwap - balanceBeforeSwap;
        require(amountOut >= minAmountOut, "Insufficient output amount");

        return amountOut;
    }

    function collectFeesFromLiquidityPool(
        IERC20 token0,
        IERC20 token1,
        uint256 tokenId
    ) internal {
        if (address(token0) > address(token1)) {
            (token0, token1) = (token1, token0);
        }

        bytes memory actions = abi.encodePacked(
            uint8(Actions.DECREASE_LIQUIDITY),
            uint8(Actions.TAKE_PAIR)
        );

        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, 0, 0, 0, "");
        params[1] = abi.encode(
            Currency.wrap(address(token0)),
            Currency.wrap(address(token1)),
            address(this)
        );

        POSITION_MANAGER.modifyLiquidities(
            abi.encode(actions, params),
            block.timestamp + 60
        );
    }

    function rebalanceLiquidityPosition(
        IERC20 token0,
        IERC20 token1,
        uint256 tokenId,
        PoolKey memory poolKey,
        int24 tickSpacing,
        int24 tickRange
    ) internal returns (uint256 newTokenId) {
        if (address(token0) > address(token1)) {
            (token0, token1) = (token1, token0);
        }

        bytes memory actions = abi.encodePacked(uint8(Actions.BURN_POSITION), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, 0, 0, "");
        params[1] = abi.encode(address(token0), address(token1), address(this));

        POSITION_MANAGER.modifyLiquidities(
            abi.encode(actions, params),
            block.timestamp + 60
        );

        (uint160 currentPrice, int24 currentTick, ,) = StateLibrary.getSlot0(POOL_MANAGER, poolKey.toId());

        currentTick = _roundTick(currentTick, tickSpacing);

        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            currentPrice,
            TickMath.getSqrtPriceAtTick(currentTick - tickRange),
            TickMath.getSqrtPriceAtTick(currentTick + tickRange),
            token0.balanceOf(address(this)),
            token1.balanceOf(address(this))
        );

        actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        params = new bytes[](2);
        params[0] = abi.encode(
            poolKey,
            currentTick - tickRange,
            currentTick + tickRange,
            liq,
            type(uint256).max,
            type(uint256).max,
            address(this),
            ""
        );
        params[1] = abi.encode(poolKey.currency0, poolKey.currency1);

        newTokenId = POSITION_MANAGER.nextTokenId();
        POSITION_MANAGER.modifyLiquidities(
            abi.encode(actions, params),
            block.timestamp + 60
        );
    }

    function _roundTick(int24 currentTick, int24 tickSpacing) internal pure returns (int24) {
        // 1) Compute the remainder of currentTick mod spacing
        int24 rem = currentTick % tickSpacing; // can be negative

        // 2) Base multiple (rounds toward zero)
        int24 base = currentTick - rem;

        // 3) If the remainder’s magnitude is at least half the spacing, step to the next multiple
        int24 absRem = rem < 0 ? -rem : rem;
        if (absRem * 2 >= tickSpacing) {
            // if rem positive, go up; if rem negative, go down
            base += rem > 0 ? tickSpacing : -tickSpacing;
        }

        return base;
    }
}
