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
