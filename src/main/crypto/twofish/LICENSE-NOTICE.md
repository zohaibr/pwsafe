# Twofish implementation: provenance and license

`twofish.ts` was written for this project directly from the published algorithm description:

> B. Schneier, J. Kelsey, D. Whiting, D. Wagner, C. Hall, N. Ferguson,
> "Twofish: A 128-Bit Block Cipher", 15 June 1998.
> https://www.schneier.com/academic/twofish/

No third-party source code was copied or translated. Twofish is unpatented and its authors
placed the algorithm in the public domain ("Twofish is unpatented, and the source code is
uncopyrighted and license-free; it is free for all uses"). This file therefore carries the
project's own license.

## Test vectors

`kat-vectors.ts` embeds known-answer values (ecb_ival.txt and ecb_tbl.txt from the authors'
`twofish-kat.zip`, https://www.schneier.com/academic/twofish/). Test vectors are factual data
published for interoperability testing. The values were obtained from, and cross-checked against,
these permissively licensed copies:

- Botan, `src/tests/data/block/twofish.vec` (BSD-2-Clause), https://github.com/randombit/botan
- Go, `golang.org/x/crypto/twofish/twofish_test.go` (BSD-3-Clause), https://github.com/golang/crypto

No GPL-licensed source was used.
