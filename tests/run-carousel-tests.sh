#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

node --check carousel.js
node --check tests/carousel-resilience.test.mjs
node --check tests/signed-events.test.mjs
node tests/carousel-resilience.test.mjs
node tests/signed-events.test.mjs
