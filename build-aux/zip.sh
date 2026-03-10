#!/bin/sh
set -eu

rm -f "$2"
cd "$1"
zip -qr "$2" .