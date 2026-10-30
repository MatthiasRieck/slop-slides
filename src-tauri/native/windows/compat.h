/* Windows adaptation for the vendored C engine only. Force-included by build.rs.
 * All engine allocations use the aligned CRT family: upstream frees aligned and
 * ordinary buffers interchangeably. Never expose these allocations to Rust's allocator.
 * SPDX-License-Identifier: MIT */
#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <malloc.h>
#include <errno.h>
#include <time.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <io.h>
#include <process.h>
#include <intrin.h>

typedef intptr_t ssize_t;
typedef int pid_t;
struct slop_stat { int64_t st_size; unsigned short st_mode; };
struct timeval { int64_t tv_sec; long tv_usec; };
void *slop_malloc(size_t size);
void *slop_calloc(size_t count, size_t size);
void *slop_realloc(void *ptr, size_t size);
char *slop_strdup(const char *s);
int posix_memalign(void **ptr, size_t alignment, size_t size);
void *slop_aligned_alloc(size_t alignment, size_t size);
FILE *slop_fopen(const char *path, const char *mode);
int slop_open(const char *path, int flags);
int slop_stat(const char *path, struct slop_stat *st);
int slop_fstat(int fd, struct slop_stat *st);
ssize_t pread(int fd, void *buffer, size_t size, int64_t offset);
int gettimeofday(struct timeval *tv, void *tz);
#define CLOCK_MONOTONIC 1
int clock_gettime(int clock, struct timespec *ts);
int nanosleep(const struct timespec *duration, struct timespec *remaining);
int slop_cpu_supports(const char *feature);

#ifndef SLOP_COMPAT_IMPLEMENTATION
#define malloc slop_malloc
#define calloc slop_calloc
#define realloc slop_realloc
#define free _aligned_free
#define strdup slop_strdup
#define aligned_alloc slop_aligned_alloc
#define fopen slop_fopen
#define open slop_open
#define stat slop_stat
#define fstat slop_fstat
#define close _close
#define getpid _getpid
#define strcasecmp _stricmp
#define strncasecmp _strnicmp
/* The Windows CRT's off_t is only 32 bits, including on x64. */
#define off_t int64_t
#define ftello _ftelli64
#define fseeko _fseeki64
#define __builtin_cpu_init() ((void)0)
#define __builtin_cpu_supports(feature) slop_cpu_supports(feature)
#endif
#define S_ISDIR(mode) (((mode) & _S_IFMT) == _S_IFDIR)
#define S_ISREG(mode) (((mode) & _S_IFMT) == _S_IFREG)
/* Cache hints have no correctness effect. Do not discard mapped model data. */
#define POSIX_FADV_DONTNEED 0
#define POSIX_FADV_SEQUENTIAL 1
static inline int posix_fadvise(int fd, int64_t off, int64_t len, int hint) {
    (void)fd; (void)off; (void)len; (void)hint; return 0;
}

static inline struct tm *gmtime_r(const time_t *time, struct tm *result) {
    return gmtime_s(result, time) == 0 ? result : NULL;
}
