import {
  concat, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, pad, toFunctionSelector,
  type Address, type Hex, type PublicClient,
} from "viem";
import { isMigrationAction } from "./tokenSignals.js";

/**
 * How many new tokens one old token really gets — the number a trader acts
 * on, and the one ratio getters hide behind scales and directions
 * (`SWAP_RATIO() = 750`: × 750? ÷ 750? / 1e18?).
 *
 * 1. Simulated: the exchange itself, made in an eth_call by a probe holding
 *    old tokens (state overrides — nothing is sent). Exact, scale and
 *    direction included; before the start time it runs at the start time,
 *    and an unfunded migrator is funded for the call.
 * 2. From the ratio getter, read every plausible way (× r, ÷ r, r / 1e18,
 *    basis points…) and kept when the market agrees with it.
 */

/** Runtime code of MigrationProbe.sol. */
export const PROBE_CODE: Hex = "0x608060405234801561000f575f80fd5b5060043610610029575f3560e01c806301d6e7bc1461002d575b5f80fd5b61004061003b3660046102d2565b610061565b60408051931515845260208401929092529082015260600160405180910390f35b604080516001600160a01b0385811660248301525f1960448084019190915283518084039091018152606490920183526020820180516001600160e01b031663095ea7b360e01b17905291515f928392839283928b16916100c19161036c565b5f604051808303815f865af19150503d805f81146100fa576040519150601f19603f3d011682016040523d82523d5f602084013e6100ff565b606091505b505090505f61010d8a6101ea565b90505f6101198a6101ea565b9050886001600160a01b03168888604051610135929190610398565b5f604051808303815f865af19150503d805f811461016e576040519150601f19603f3d011682016040523d82523d5f602084013e610173565b606091505b5050809650508561018f575f805f9550955095505050506101df565b5f6101998c6101ea565b90505f6101a58c6101ea565b90508281116101b4575f6101be565b6101be83826103a7565b96508184116101cd575f6101d7565b6101d782856103a7565b955050505050505b955095509592505050565b604080513060248083019190915282518083039091018152604490910182526020810180516001600160e01b03166370a0823160e01b17905290515f91829182916001600160a01b03861691610240919061036c565b5f60405180830381855afa9150503d805f8114610278576040519150601f19603f3d011682016040523d82523d5f602084013e61027d565b606091505b509150915081801561029157506020815110155b61029b575f6102af565b808060200190518101906102af91906103cc565b949350505050565b80356001600160a01b03811681146102cd575f80fd5b919050565b5f805f805f608086880312156102e6575f80fd5b6102ef866102b7565b94506102fd602087016102b7565b935061030b604087016102b7565b9250606086013567ffffffffffffffff80821115610327575f80fd5b818801915088601f83011261033a575f80fd5b813581811115610348575f80fd5b896020828501011115610359575f80fd5b9699959850939650602001949392505050565b5f82515f5b8181101561038b5760208186018101518583015201610371565b505f920191825250919050565b818382375f9101908152919050565b818103818111156103c657634e487b7160e01b5f52601160045260245ffd5b92915050565b5f602082840312156103dc575f80fd5b505191905056fea2646970667358221220811464e1ffd2f1a3d4329f4547e5761991385a2d15ac0c73b478ac54c07f1e7a64736f6c63430008180033";
/** An address with no code or state on any chain, where the probe runs. */
export const PROBE_ADDRESS: Address = "0x00000000000000000000000000000000c0ffee01";

const PROBE_ABI = [{
  type: "function", name: "probe", stateMutability: "nonpayable",
  inputs: [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "bytes" }],
  outputs: [{ type: "bool" }, { type: "uint256" }, { type: "uint256" }],
}] as const;
const BALANCE_OF = toFunctionSelector("balanceOf(address)");

const MARKER = 0xc0ffeen << 200n;

/**
 * Storage keys a token may keep `holder`'s balance under: Solidity mappings
 * at slots 0–39, Vyper's (key order reversed), OpenZeppelin 5's namespaced
 * ERC20 storage and Solady's seeded slot.
 */
export function balanceSlotCandidates(holder: Address): Hex[] {
  const out: Hex[] = [];
  for (let slot = 0n; slot < 40n; slot++) {
    out.push(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, slot])));
    out.push(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [slot, holder])));
  }
  out.push(keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [holder, "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"])));
  out.push(keccak256(concat([holder, "0x000000000000000087a211a2"])));
  return out;
}

/**
 * Where `token` keeps `holder`'s balance: every candidate key set to a
 * different marked value in one eth_call, and balanceOf says which it read.
 */
export async function findBalanceSlot(client: PublicClient, token: Address, holder: Address): Promise<Hex | null> {
  const keys = balanceSlotCandidates(holder);
  try {
    const { data } = await client.call({
      to: token,
      data: concat([BALANCE_OF, pad(holder)]),
      stateOverride: [{ address: token, stateDiff: keys.map((slot, i) => ({ slot, value: numberToHex(MARKER + BigInt(i), { size: 32 }) })) }],
    });
    if (!data || data.length !== 66) return null;
    const i = BigInt(data) - MARKER;
    return i >= 0n && i < BigInt(keys.length) ? keys[Number(i)]! : null;
  } catch {
    return null;
  }
}

/** The calls a holder would make to exchange `amount`, from the contract's functions. */
export function exchangeCalls(signatures: Map<string, string>, selectors: Hex[], tokenA: Address, amount: bigint): Hex[] {
  const calls: Hex[] = [];
  for (const [selector, sig] of signatures) {
    if (!selectors.includes(selector as Hex)) continue;
    const name = sig.split("(")[0] ?? "";
    // migrate(…)/convert(…) and the old-to-new pairs named after both tokens: quickToQuickX, mkrToSky.
    if (!isMigrationAction(sig) && !/^[a-z][A-Za-z0-9]*To[A-Z][A-Za-z0-9]*$/.test(name)) continue;
    const args = sig.slice(name.length + 1, -1);
    const enc = (types: string[], values: unknown[]) => concat([selector as Hex, encodeAbiParameters(types.map((type) => ({ type })), values)]);
    if (args === "") calls.push(selector as Hex);
    else if (args === "uint256") calls.push(enc(["uint256"], [amount]));
    else if (args === "uint256,address") calls.push(enc(["uint256", "address"], [amount, PROBE_ADDRESS]));
    else if (args === "address,uint256") {
      calls.push(enc(["address", "uint256"], [PROBE_ADDRESS, amount]));
      calls.push(enc(["address", "uint256"], [tokenA, amount]));
    }
  }
  return calls.slice(0, 6);
}

export interface SimulatedExchange {
  /** Raw new tokens received for `spent` raw old tokens. */
  received: bigint;
  spent: bigint;
}

export interface SimulateInput {
  contract: Address;
  tokenA: Address;
  tokenB: Address;
  signatures: Map<string, string>;
  selectors: Hex[];
  /** Raw old tokens to exchange. */
  amount: bigint;
  /** Run at this time (unix seconds) — a migration that opens later. */
  at?: number | null;
  /** The migrator holds no new tokens yet: give it some for the call. */
  fundContract?: boolean;
}

/** The exchange made in an eth_call by a probe holding old tokens. Null when no way through works. */
export async function simulateExchange(client: PublicClient, input: SimulateInput): Promise<SimulatedExchange | null> {
  const calls = exchangeCalls(input.signatures, input.selectors, input.tokenA, input.amount);
  if (calls.length === 0) return null;
  const slotA = await findBalanceSlot(client, input.tokenA, PROBE_ADDRESS);
  if (!slotA) return null;
  const stateOverride: NonNullable<Parameters<PublicClient["call"]>[0]["stateOverride"]> = [
    { address: PROBE_ADDRESS, code: PROBE_CODE },
    { address: input.tokenA, stateDiff: [{ slot: slotA, value: numberToHex(input.amount, { size: 32 }) }] },
  ];
  if (input.fundContract && input.tokenB.toLowerCase() !== input.contract.toLowerCase()) {
    const slotB = await findBalanceSlot(client, input.tokenB, input.contract);
    if (slotB) stateOverride.push({ address: input.tokenB, stateDiff: [{ slot: slotB, value: numberToHex(2n ** 200n, { size: 32 }) }] });
  }
  for (const exchange of calls) {
    try {
      const { data } = await client.call({
        to: PROBE_ADDRESS,
        data: encodeFunctionData({ abi: PROBE_ABI, functionName: "probe", args: [input.tokenA, input.tokenB, input.contract, exchange] }),
        stateOverride,
        ...(input.at ? { blockOverrides: { time: BigInt(input.at) } } : {}),
      });
      if (!data) continue;
      const [ok, received, spent] = decodeFunctionResult({ abi: PROBE_ABI, functionName: "probe", data });
      if (ok && received > 0n) return { received, spent: spent > 0n ? spent : input.amount };
    } catch {
      // The RPC refused the overrides, or the call itself: try the next way.
    }
  }
  return null;
}

/** New tokens per old token (whole tokens) from a simulated exchange. */
export function newPerOldFromRaw(received: bigint, spent: bigint, decA: number, decB: number): number {
  // received / 10^decB ÷ spent / 10^decA, kept exact to 12 significant digits.
  const scaled = (received * 10n ** BigInt(decA) * 10n ** 12n) / (spent * 10n ** BigInt(decB));
  return Number(scaled) / 1e12;
}

/** Every way a ratio getter's raw value may read as new-per-old. */
export function ratioReadings(value: bigint, decA: number, decB: number): number[] {
  const r = Number(value);
  if (!(r > 0)) return [];
  // × r, ÷ r, 1e18-scaled either way, basis points. Few, far-apart readings: the
  // market can only confirm one when they don't crowd every decade.
  const base = [r, 1 / r, r / 1e18, 1e18 / r, r / 1e4];
  // A ratio over raw units differs from one over whole tokens by the decimals gap.
  const gap = 10 ** (decA - decB);
  return [...base, ...(gap !== 1 ? base.map((x) => x * gap) : [])].filter((x) => Number.isFinite(x) && x > 0);
}

/**
 * Farthest (as a factor) the market may sit from a reading for it still to
 * count as confirmed — room for a thin new pool's price, not for a decade.
 */
const MARKET_TOLERANCE = 2.5;

/**
 * The reading of a ratio getter: the one the market (old price ÷ new price)
 * sits closest to, when within a factor of 2.5; with no market to check
 * against, the plain one — 1e18-scaled when it is that large, else × r.
 */
export function interpretRatio(
  value: bigint,
  decA: number,
  decB: number,
  marketNewPerOld: number | null,
): { newPerOld: number; checked: boolean } | null {
  const readings = ratioReadings(value, decA, decB);
  if (readings.length === 0) return null;
  if (marketNewPerOld && marketNewPerOld > 0) {
    const off = (x: number) => Math.abs(Math.log(x / marketNewPerOld));
    const best = readings.reduce((a, b) => (off(b) < off(a) ? b : a));
    return off(best) <= Math.log(MARKET_TOLERANCE) ? { newPerOld: best, checked: true } : null;
  }
  return { newPerOld: value >= 10n ** 15n ? Number(value) / 1e18 : Number(value), checked: false };
}
