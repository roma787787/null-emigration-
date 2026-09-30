// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SimpleToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public owner;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint256 supply) {
        name = n; symbol = s; owner = msg.sender;
        totalSupply = supply; balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }
    function transferOwnership(address n) external { require(msg.sender == owner); owner = n; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; emit Transfer(msg.sender, to, v); return true;
    }
    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true;
    }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); return true;
    }
}

/// Case 1: public getters + migrate() + Migrated event -> expect HIGH via newToken() getter
contract MigratorWithGetters {
    address public oldToken;
    address public newToken;
    uint256 public rate = 1;
    event Migrated(address indexed user, uint256 amount);
    constructor(address a, address b) { oldToken = a; newToken = b; }
    function migrate(uint256 amount) external {
        SimpleToken(oldToken).transferFrom(msg.sender, address(this), amount);
        SimpleToken(newToken).transfer(msg.sender, amount * rate);
        emit Migrated(msg.sender, amount);
    }
}

/// Case 2: token addresses only in private storage -> must come from constructor args
contract MigratorPrivate {
    address private a;
    address private b;
    constructor(address tokenA, address tokenB) { a = tokenA; b = tokenB; }
    function swap(uint256 amount) external {
        SimpleToken(a).transferFrom(msg.sender, address(this), amount);
        SimpleToken(b).transfer(msg.sender, amount);
    }
}

/// Case 3: migration-ish function, no token configured yet -> expect MEDIUM
contract MigratorUnconfigured {
    address private b;
    address public admin;
    constructor() { admin = msg.sender; }
    function setToken(address x) external { require(msg.sender == admin); b = x; }
    function claim() external {}
}

/// Case 4: unrelated contract -> expect LOW
contract Counter {
    uint256 public n;
    function inc() external { n++; }
}

/// Case 5: factory deploying a migrator via CREATE2 -> tests trace-based detection
contract MigratorFactory {
    event Deployed(address m);
    function deploy(address a, address b, bytes32 salt) external returns (address m) {
        m = address(new MigratorWithGetters{salt: salt}(a, b));
        emit Deployed(m);
    }
}

/// Case 6: migrator logic meant to sit behind a proxy (storage set via initialize).
contract MigratorUpgradeable {
    address public oldToken;
    address public newToken;
    bool private initialized;
    event Migrated(address indexed user, uint256 amount);
    function initialize(address a, address b) external {
        require(!initialized);
        initialized = true;
        oldToken = a;
        newToken = b;
    }
    function migrate(uint256 amount) external {
        SimpleToken(oldToken).transferFrom(msg.sender, address(this), amount);
        SimpleToken(newToken).transfer(msg.sender, amount);
        emit Migrated(msg.sender, amount);
    }
}

/// Minimal EIP-1967 proxy: its own bytecode is just a delegatecall stub.
contract SimpleProxy {
    bytes32 private constant IMPL_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
    constructor(address impl, bytes memory initData) {
        bytes32 slot = IMPL_SLOT;
        assembly { sstore(slot, impl) }
        if (initData.length > 0) {
            (bool ok, ) = impl.delegatecall(initData);
            require(ok);
        }
    }
    fallback() external payable {
        bytes32 slot = IMPL_SLOT;
        assembly {
            let impl := sload(slot)
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

/// EIP-1167 minimal-proxy ("clone") factory, as in OpenZeppelin Clones.
contract CloneFactory {
    event Cloned(address instance);
    function clone(address impl) external returns (address instance) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        require(instance != address(0));
        emit Cloned(instance);
    }
}

// ---------------------------------------------------------------------------
// Shapes of real-world migrations (non-standard names the fixed lists miss)
// ---------------------------------------------------------------------------

/// MKR-style token: symbol()/name() return bytes32, not string.
contract Bytes32Token {
    bytes32 public constant symbol = "MKR";
    bytes32 public constant name = "Maker";
    uint256 public totalSupply;
    address public owner;
    mapping(address => uint256) public balanceOf;
    constructor(uint256 supply) { owner = msg.sender; totalSupply = supply; balanceOf[msg.sender] = supply; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
}

/// Aave LEND->AAVE style: immutables LEND()/AAVE(), migrateFromLEND(), LendMigrated.
contract LendStyleMigrator {
    address public immutable LEND;
    address public immutable AAVE;
    uint256 public constant LEND_AAVE_RATIO = 100;
    // Like Aave's real migrator: a small uint getter whose value (3) is also
    // the address of the RIPEMD-160 precompile, which answers any call.
    uint256 public constant REVISION = 3;
    event LendMigrated(address indexed sender, uint256 indexed amount);
    constructor(address lend, address aave) { LEND = lend; AAVE = aave; }
    function migrateFromLEND(uint256 amount) external {
        SimpleToken(LEND).transferFrom(msg.sender, address(this), amount);
        SimpleToken(AAVE).transfer(msg.sender, amount / LEND_AAVE_RATIO);
        emit LendMigrated(msg.sender, amount);
    }
}

/// Sky MKR->SKY style: mkr()/sky()/rate() immutables, mkrToSky().
contract SkyStyleConverter {
    address public immutable mkr;
    address public immutable sky;
    uint256 public immutable rate;
    event MkrToSky(address indexed caller, address indexed usr, uint256 mkrAmt, uint256 skyAmt);
    constructor(address mkr_, address sky_, uint256 rate_) { mkr = mkr_; sky = sky_; rate = rate_; }
    function mkrToSky(address usr, uint256 mkrAmt) external {
        emit MkrToSky(msg.sender, usr, mkrAmt, mkrAmt * rate);
    }
}

/// Polygon MATIC->POL style (behind a proxy): matic()/polygonEcosystemToken(), migrate()/unmigrate().
contract PolStyleMigration {
    address public matic;
    address public polygonEcosystemToken;
    bool private initialized;
    event Migrated(address indexed account, uint256 amount);
    function initialize(address matic_, address pol_) external {
        require(!initialized);
        initialized = true;
        matic = matic_;
        polygonEcosystemToken = pol_;
    }
    function migrate(uint256 amount) external { emit Migrated(msg.sender, amount); }
    function unmigrate(uint256 amount) external { emit Migrated(msg.sender, amount); }
}

/// USDT style: a plain ERC-20 that happens to have redeem()/issue().
contract UsdtStyleToken {
    string public name = "Tether USD";
    string public symbol = "USDT";
    uint256 public totalSupply;
    address public owner;
    mapping(address => uint256) public balanceOf;
    constructor(uint256 supply) { owner = msg.sender; totalSupply = supply; balanceOf[msg.sender] = supply; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    function issue(uint256 amount) external { totalSupply += amount; balanceOf[owner] += amount; }
    function redeem(uint256 amount) external { totalSupply -= amount; balanceOf[owner] -= amount; }
}

// ---- Auto-discovery fixtures -------------------------------------------------------

/// Uniswap-V2-style pair: two tokens and swap(), but a pool, not a migration.
contract FakePair {
    address public token0;
    address public token1;
    constructor(address a, address b) { token0 = a; token1 = b; }
    function swap(uint256, uint256, address, bytes calldata) external {}
    function getReserves() external pure returns (uint112, uint112, uint32) { return (0, 0, 0); }
}

/// Meme token with fee-swap plumbing: "swap" in a token is not a migration.
contract FeeToken {
    string public name = "Fee Token";
    string public symbol = "FEE";
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1e24;
    address public pairedToken;
    mapping(address => uint256) public balanceOf;
    constructor(address paired) { pairedToken = paired; balanceOf[msg.sender] = totalSupply; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function swapTokensForEth(uint256) external {}
    function swapBack() external {}
}

/// Names Token B only by ticker: must stay Unverified / LOW.
contract SymbolOnlyMigrator {
    address public oldToken;
    string public newTokenSymbol = "NEWT";
    constructor(address a) { oldToken = a; }
    function migrate(uint256) external {}
}

/// The new token itself takes the old one in: Token B is the contract.
contract MigratingToken {
    string public name = "Migrated Token";
    string public symbol = "MIG";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public oldToken;
    mapping(address => uint256) public balanceOf;
    constructor(address a) { oldToken = a; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function migrate(uint256 amount) external { totalSupply += amount; balanceOf[msg.sender] += amount; }
}

/// Tokenized-stock style migrator: ISIN / issuer getters.
contract RwaMigrator {
    address public oldToken;
    address public newToken;
    address public issuer;
    string public isin = "US0378331005";
    constructor(address a, address b) { oldToken = a; newToken = b; issuer = msg.sender; }
    function migrate(uint256) external {}
}

/// Where a migrator reads its tokens from at construction.
contract TokenRegistry {
    address public oldOne;
    address public newOne;
    constructor(address a, address b) { oldOne = a; newOne = b; }
}

/// Tokens only as private immutables (spliced into the runtime code): no
/// getters, not in its own constructor args — only the bytecode tells.
contract HardcodedMigrator {
    address private immutable OLD;
    address private immutable NEW;
    constructor(TokenRegistry r) { OLD = r.oldOne(); NEW = r.newOne(); }
    function migrate(uint256 amount) external {
        SimpleToken(OLD).transferFrom(msg.sender, address(this), amount);
        SimpleToken(NEW).transfer(msg.sender, amount);
    }
}

/// Deployed empty, pointed at its tokens by a later transaction.
contract LateConfiguredMigrator {
    address public oldToken;
    address public newToken;
    address private admin;
    constructor() { admin = msg.sender; }
    function setTokens(address a, address b) external { require(msg.sender == admin); oldToken = a; newToken = b; }
    function migrate(uint256) external {}
}

/// Swap bot / aggregator shape: tokenIn/tokenOut and swap functions — not a migration.
contract SwapBot {
    address public tokenIn;
    address public tokenOut;
    address private owner;
    constructor(address a, address b) { tokenIn = a; tokenOut = b; owner = msg.sender; }
    function swapExactIn(uint256) external {}
    function swapTokens(uint256, uint256) external {}
    function execute(bytes calldata) external {}
}

/// Zap / presale shape: buys and swaps a liquid token, references a second one.
contract ZapPresale {
    address public token;
    address public rewardToken;
    constructor(address a, address b) { token = a; rewardToken = b; }
    function swapAndLiquify(uint256) external {}
    function buyTokens() external payable {}
    function exchange(uint256) external {}
}

/// migrate() + oldToken() but no target token anywhere.
contract MigratorNoTarget {
    address public oldToken;
    constructor(address a) { oldToken = a; }
    function migrate(uint256) external {}
}

/// CREATE2 deployer that receives the creation code in calldata (CreateX / Arachnid shape).
contract BytecodeDeployer {
    event Deployed(address a);
    function deploy(bytes memory code, bytes32 salt) external returns (address a) {
        assembly { a := create2(0, add(code, 0x20), mload(code), salt) }
        require(a != address(0));
        emit Deployed(a);
    }
}

/// ERC-4626 vault (gtWETH / USDG-vault shape): share token over a liquid asset.
contract Erc4626LikeVault {
    string public name = "Vault Share";
    string public symbol = "vSHR";
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1e24;
    address public asset;
    mapping(address => uint256) public balanceOf;
    constructor(address a) { asset = a; balanceOf[msg.sender] = totalSupply; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function totalAssets() external pure returns (uint256) { return 0; }
    function convertToShares(uint256 a) external pure returns (uint256) { return a; }
    function convertToAssets(uint256 s) external pure returns (uint256) { return s; }
    function deposit(uint256, address) external pure returns (uint256) { return 0; }
}

/// ERC-4626 vault that also has migrate() (the MATIC-vault false positive).
contract VaultWithMigrate {
    string public name = "Staked Vault";
    string public symbol = "sVLT";
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1e24;
    address public asset;
    mapping(address => uint256) public balanceOf;
    constructor(address a) { asset = a; balanceOf[msg.sender] = totalSupply; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function totalAssets() external pure returns (uint256) { return 0; }
    function convertToShares(uint256 a) external pure returns (uint256) { return a; }
    function convertToAssets(uint256 s) external pure returns (uint256) { return s; }
    function migrate(uint256) external {}
}

/// Meme token whose "migration" is its bonding-curve pool moving to a DEX (four.meme shape).
contract MemePoolToken {
    string public name = "Meme";
    string public symbol = "MEME";
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1e24;
    address public quoteToken;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public migratedPools;
    constructor(address q) { quoteToken = q; balanceOf[msg.sender] = totalSupply; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function setMigratedPool(address p, bool v) external { migratedPools[p] = v; }
    function setMigratedPools(address[] calldata ps, bool v) external { for (uint256 i; i < ps.length; i++) migratedPools[ps[i]] = v; }
}

/// Robinhood StockFactory shape: an operator calls it, it CREATEs (no salt) —
/// mostly stock tokens, occasionally a migration contract.
contract StockFactoryLike {
    function deployMigrator(address a, address b) external returns (address m) { m = address(new MigratorWithGetters(a, b)); }
    function deployStock(string memory n, string memory s) external returns (address t) { t = address(new SimpleToken(n, s, 1e24)); }
}

/// A multisig / relayer between the operator and a custodian factory: the tx
/// goes to it, not to the factory.
contract Forwarder {
    function forward(address to, bytes calldata data) external {
        (bool ok, ) = to.call(data);
        require(ok, "forward failed");
    }
}

/// Aave aToken shape: a deposit receipt over a base asset (aOptWETH / aBasWETH).
contract ATokenLike is SimpleToken {
    address public UNDERLYING_ASSET_ADDRESS;
    constructor(address u) SimpleToken("Aave Optimism WETH", "aOptWETH", 1e24) { UNDERLYING_ASSET_ADDRESS = u; }
}

/// The Optimism/Base 0x067f… shape: migrate(address) plus a Uniswap V3 swap
/// callback, tokens compiled in — a trading / position bot.
contract CallbackBotMigrate {
    address immutable a;
    address immutable b;
    constructor(address x, address y) { a = x; b = y; }
    function migrate(address to) external { SimpleToken(a).transfer(to, 1); SimpleToken(b).transfer(to, 1); }
    function uniswapV3SwapCallback(int256, int256, bytes calldata) external {}
}

/// four.meme-style token (BSC cards: BNC4 / NVDAB / QQQB…): pool-graduation
/// settings plus a function that is itself named migrate — still a launchpad token.
contract LaunchpadTokenWithMigrate {
    string public name = "Launch";
    string public symbol = "LNCH";
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1e24;
    address public quoteToken;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public migratedPools;
    constructor(address q) { quoteToken = q; balanceOf[msg.sender] = totalSupply; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function setMigratedPool(address p, bool v) external { migratedPools[p] = v; }
    function setMigratedPools(address[] calldata ps, bool v) external { for (uint256 i; i < ps.length; i++) migratedPools[ps[i]] = v; }
    function migrate() external {}
}

/// Launch token with graduation phases (BSC cards: FXIon / NVDAB …7777).
contract PhasedLaunchToken {
    string public name = "Phased";
    string public symbol = "PHSD";
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1e24;
    address public quoteToken;
    bool public migrating;
    mapping(address => uint256) public balanceOf;
    constructor(address q) { quoteToken = q; balanceOf[msg.sender] = totalSupply; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function startMigration() external { migrating = true; }
    function finalizeMigration() external { migrating = false; }
}

/// Backfill shapes (Ethereum, 7 days) that are not token migrations:

/// Ondo TSLAon / UNI / CULT wrappers: the token itself, with a converter() getter.
contract WrapperWithConverter is SimpleToken {
    address public underlying;
    address public converter;
    constructor(address u, address c) SimpleToken("Wrapped", "wRAP", 1e24) { underlying = u; converter = c; }
}

/// The MATIC share token: migrate() for the legacy token, share conversions, no asset()/totalAssets().
contract ShareTokenWithMigrate is SimpleToken {
    address public legacyToken;
    constructor(address l) SimpleToken("Staked Share", "sSHR", 1e24) { legacyToken = l; }
    function migrate(uint256) external {}
    function migrateLegacyMatic(uint256) external {}
    function convertToShares(uint256 a) external pure returns (uint256) { return a; }
    function convertToAssets(uint256 s) external pure returns (uint256) { return s; }
}

/// EARN: a staking contract moving stakes, with the staked token referenced.
contract StakeMigrator {
    address public stakingToken;
    address public newStaking;
    constructor(address t, address n) { stakingToken = t; newStaking = n; }
    function migrateStake(address, uint256) external {}
}

/// RLUSD -> PYUSD, crvUSD <-> reUSD: a converter between two dollar tokens.
contract StableConverter {
    address public fromToken;
    address public toToken;
    constructor(address a, address b) { fromToken = a; toToken = b; }
    function convert(address, address, uint256) external {}
}

/// wTAO style: a new token minted for an existing, traded one through a bare
/// convert() — a wrapper or a sale, not a migration.
contract ConvertMintToken is SimpleToken {
    address public tao;
    constructor(address t) SimpleToken("Subnet", "SN", 1e24) { tao = t; }
    function convert(uint256) external {}
}

/// A new token that names what it converts from: still a migration.
contract ConvertFromOldToken is SimpleToken {
    address public legacy;
    constructor(address t) SimpleToken("Next", "NXT", 1e24) { legacy = t; }
    function convertFromOld(uint256) external {}
}
