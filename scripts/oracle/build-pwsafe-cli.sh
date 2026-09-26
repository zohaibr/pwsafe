#!/usr/bin/env bash
# Builds the compatibility oracle: pwsafe-cli from Password Safe tag 1.25.0 (docs/references.md).
# Ubuntu only. Output: .oracle/pwsafe-cli and .oracle/xml/pwsafe.xsd
# Use with: PWSAFE_CLI=.oracle/pwsafe-cli PWS_XMLDIR=$PWD/.oracle/xml/ npm test
set -euo pipefail

TAG="1.25.0"
COMMIT="da4460325ac41ccd798a52d9b250ef4d5c768abc"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${ROOT}/.oracle"

mkdir -p "${WORK}"
if [[ ! -d "${WORK}/src/.git" ]]; then
  git clone --quiet --depth 1 --branch "${TAG}" https://github.com/pwsafe/pwsafe "${WORK}/src"
fi
ACTUAL="$(git -C "${WORK}/src" rev-parse HEAD)"
if [[ "${ACTUAL}" != "${COMMIT}" ]]; then
  echo "pwsafe tag ${TAG} resolves to ${ACTUAL}, expected ${COMMIT}" >&2
  exit 1
fi
echo "pwsafe-cli oracle source: tag ${TAG} commit ${ACTUAL}"

cmake -S "${WORK}/src" -B "${WORK}/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DNO_GTEST=ON -DNO_YUBI=ON -DNO_QR=ON >/dev/null
cmake --build "${WORK}/build" --target pwsafe-cli

cp "${WORK}/build/cli/pwsafe-cli" "${WORK}/pwsafe-cli"
mkdir -p "${WORK}/xml"
cp "${WORK}/src/xml/pwsafe.xsd" "${WORK}/xml/pwsafe.xsd"
echo "built ${WORK}/pwsafe-cli"
