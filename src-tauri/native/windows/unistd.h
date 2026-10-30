#pragma once
#include "compat.h"
#define _SC_NPROCESSORS_ONLN 1
#define _SC_PAGESIZE 2
static inline long sysconf(int name) {
    SYSTEM_INFO info;
    GetSystemInfo(&info);
    if (name == _SC_NPROCESSORS_ONLN) return info.dwNumberOfProcessors;
    if (name == _SC_PAGESIZE) return info.dwPageSize;
    errno = EINVAL; return -1;
}
