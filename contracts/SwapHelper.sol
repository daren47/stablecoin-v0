// SPDX-License-Identifier: MIT
// Depends on Uniswap v4 (BUSL-1.1)

pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {IAllowanceTransfer} from "@uniswap/v4-periphery/lib/permit2/src/interfaces/IAllowanceTransfer.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

contract SwapHelper {

    IUniversalRouter constant ROUTER = IUniversalRouter(0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af);
    IAllowanceTransfer constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    function approve(address token) internal {
        IERC20(token).approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(token, address(ROUTER), type(uint160).max, type(uint48).max);
    }

    function swapTokens(address tokenIn, address tokenOut, address poolHooks, uint128 amount) external returns (uint256 amountOut) {
        address token0 = tokenIn;
        address token1 = tokenOut;
        bool zeroForOne = true;
        if (tokenIn > tokenOut) {
            token0 = tokenOut;
            token1 = tokenIn;
            zeroForOne = false;
        }

        PoolKey memory poolKey = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(poolHooks)
        });

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amount);

        approve(tokenIn);
        amountOut = swapExactInputSingle(poolKey, amount, zeroForOne);

        IERC20(tokenOut).transfer(msg.sender, amountOut);
    }

    function swapExactInputSingle(
        PoolKey memory key,
        uint128 amountIn,
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

        // this contract is just for doing swaps in the demo script, so we don't
        // care about minAmountOut.
        uint128 minAmountOut = 0;

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
        if (zeroForOne) {
            params[1] = abi.encode(key.currency0, amountIn);
            params[2] = abi.encode(key.currency1, minAmountOut);
        } else {
            params[1] = abi.encode(key.currency1, amountIn);
            params[2] = abi.encode(key.currency0, minAmountOut);
        }

        // Combine actions and params into inputs
        inputs[0] = abi.encode(actions, params);

        // Execute the swap
        uint256 deadline = block.timestamp + 300;
        ROUTER.execute(commands, inputs, deadline);

        // Verify and return the output amount
        if (zeroForOne) {
            amountOut = key.currency1.balanceOf(address(this));
        } else {
            amountOut = key.currency0.balanceOf(address(this));
        }
        return amountOut;
    }
}
