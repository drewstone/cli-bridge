{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  name = "cli-bridge-harness-profile";

  packages = with pkgs; [
    bash
    cacert
    curl
    git
    nodejs_22
    python3
    uv
  ];

  shellHook = ''
    echo "cli-bridge harness profile"
    echo "Run: sh scripts/install-harness.sh <claude|codex|opencode|kimi|gemini|all>"
    echo "Auth/config still lives in each CLI's normal home directory."
  '';
}
