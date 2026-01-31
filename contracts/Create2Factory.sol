// SPDX-License-Identifier: MIT

pragma solidity ^0.8.28;

/// @notice Allows any EOA to deploy arbitrary init-code via CREATE2
contract Create2Factory {
    function deploy(bytes memory code, bytes32 salt) external returns (address addr) {
        assembly {
            addr := create2(0, add(code, 0x20), mload(code), salt)
            if iszero(extcodesize(addr)) { revert(0, 0) }
        }
    }
}
