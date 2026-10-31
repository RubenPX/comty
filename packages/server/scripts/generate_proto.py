#!/usr/bin/env python3
"""Compatibility entry point. Requires Bun and the server's TypeScript dependency."""
import pathlib
import subprocess
import sys

if __name__ == '__main__':
    script = pathlib.Path(__file__).with_name('generate-proto.ts')
    try:
        sys.exit(subprocess.call(['bun', str(script), *sys.argv[1:]]))
    except FileNotFoundError:
        sys.exit('Bun is required: install dependencies, then run bun run build:proto.')
