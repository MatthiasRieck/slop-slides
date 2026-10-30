#pragma once
#include "../compat.h"
#define PROT_READ 1
#define MAP_PRIVATE 2
#define MAP_FAILED ((void *)-1)
void *mmap(void *address, size_t size, int protection, int flags, int fd, int64_t offset);
int munmap(void *address, size_t size);

#define POSIX_MADV_DONTNEED 0
static inline int posix_madvise(void *address, size_t size, int hint) {
    (void)address; (void)size; (void)hint; return 0;
}
