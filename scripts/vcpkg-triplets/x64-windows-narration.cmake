# Static BLAS using the app's dynamic MSVC CRT. The MSVC port cannot build
# OpenBLAS's GNU-assembly kernels or DYNAMIC_ARCH. Use its supported portable C
# backend, rather than detecting the CI host CPU. Qwen still uses AVX2/FMA kernels.
set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
if(PORT STREQUAL "openblas")
    set(VCPKG_CMAKE_CONFIGURE_OPTIONS "-DTARGET=GENERIC" "-DNUM_THREADS=64")
endif()
