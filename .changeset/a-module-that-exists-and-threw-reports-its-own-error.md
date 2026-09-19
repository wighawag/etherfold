---
'@etherfold/utils': patch
---

**A processor module that exists and THREW now reports its own error, instead of the package resolver's "Cannot find module".**

`loadProcessorModule` imports a relative path and, on ANY failure, fell back to resolving the specifier through `createRequire(cwd/node_modules).resolve(...)` with the first error discarded. So an operator whose module was found and then failed -- a syntax error, a top-level throw, an import IT makes that does not resolve -- was told `Cannot find module './dist/processor.js'`, which sends them to look at their path when the fault is inside their code.

The fallback exists for ONE condition: the specifier named no file, so it might name a package instead. That is now the only condition under which it is taken (`ERR_MODULE_NOT_FOUND`), and even then the ORIGINAL error is what propagates if the fallback also fails, because the original is the one that describes what the operator actually asked for. A bare package specifier still resolves exactly as before.

The discriminator is the error CODE and deliberately not a match on the message text: a module whose own missing sibling raises the same code names both the sibling and the module it was imported from, so no text match can tell that apart from a missing entry point. Such a module still takes the fallback, the fallback still fails, and the error shown is still the one naming the sibling.
