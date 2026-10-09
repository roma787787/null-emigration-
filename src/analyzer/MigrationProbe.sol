// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Never deployed. eth_call runs it as the code of an empty address (a state
/// override) that another override has given old tokens: it approves the
/// migration contract, makes the exchange the way a holder would, and returns
/// how many new tokens came back for how many old ones. Nothing is sent —
/// it is a simulation, and its result is the contract's real rate.
///
/// Runtime bytecode in migrationRate.ts (PROBE_CODE); regenerate with
/// solc 0.8.24, optimizer 200 runs, `evm.deployedBytecode`.
contract MigrationProbe {
    function probe(address tokenA, address tokenB, address target, bytes calldata exchange)
        external
        returns (bool ok, uint256 received, uint256 spent)
    {
        // approve(target, max) — low-level: some tokens return nothing.
        (bool approved, ) = tokenA.call(abi.encodeWithSelector(0x095ea7b3, target, type(uint256).max));
        approved;
        uint256 beforeA = balance(tokenA);
        uint256 beforeB = balance(tokenB);
        (ok, ) = target.call(exchange);
        if (!ok) return (false, 0, 0);
        uint256 afterA = balance(tokenA);
        uint256 afterB = balance(tokenB);
        received = afterB > beforeB ? afterB - beforeB : 0;
        spent = beforeA > afterA ? beforeA - afterA : 0;
    }

    function balance(address token) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        return ok && data.length >= 32 ? abi.decode(data, (uint256)) : 0;
    }
}
