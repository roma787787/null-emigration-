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
