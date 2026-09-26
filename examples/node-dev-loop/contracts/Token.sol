// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

contract Token {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);

    function mint(address to, uint256 id) external {
        emit Transfer(address(0), to, id);
    }

    function transfer(address from, address to, uint256 id) external {
        emit Transfer(from, to, id);
    }

    function approve(address approved, uint256 id) external {
        emit Approval(msg.sender, approved, id);
    }
}
