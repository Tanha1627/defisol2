// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockERC20 — a test token with an open faucet.
/// @notice Anyone can mint themselves tokens. Testnet only, obviously.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // Cap per faucet call so the UI can show a sane "Get test tokens" button.
    uint256 public immutable faucetAmount;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        uint256 _faucetAmount
    ) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        faucetAmount = _faucetAmount;
    }

    /// @notice Mint yourself one faucet allotment (e.g. 10 WETH or 10,000 USDC).
    function faucet() external {
        _mint(msg.sender, faucetAmount);
    }

    /// @notice Mint an arbitrary amount to any address (handy in deploy scripts).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ERC20: insufficient allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "ERC20: insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
