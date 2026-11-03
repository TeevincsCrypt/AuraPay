// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract MockToken { // returns bool, like USDT on Polygon
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external virtual returns (bool) { require(balanceOf[msg.sender] >= a); balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external virtual returns (bool) { require(allowance[f][msg.sender] >= a && balanceOf[f] >= a); allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true; }
}
contract FeeToken is MockToken { // takes 1% on transferFrom
    function transferFrom(address f, address to, uint256 a) external override returns (bool) { require(allowance[f][msg.sender] >= a && balanceOf[f] >= a); allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a - a / 100; return true; }
}
interface IVault { function release(uint256 id) external; }
contract ReentrantToken is MockToken { // tries to re-enter release() during transfer
    IVault public vault; uint256 public target; bool public tried;
    function arm(IVault v, uint256 id) external { vault = v; target = id; }
    function transfer(address to, uint256 a) external override returns (bool) { if (address(vault) != address(0) && !tried) { tried = true; try vault.release(target) { revert("reentered"); } catch {} } balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
}
