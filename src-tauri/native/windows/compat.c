#define SLOP_COMPAT_IMPLEMENTATION
#include "compat.h"
#include "pthread.h"
#include "dirent.h"
#include "sys/mman.h"

void *slop_malloc(size_t size) { return _aligned_malloc(size ? size : 1, 64); }
void *slop_calloc(size_t count, size_t size) {
    if (size && count > SIZE_MAX / size) { errno = ENOMEM; return NULL; }
    void *p = slop_malloc(count * size);
    if (p) memset(p, 0, count * size);
    return p;
}
void *slop_realloc(void *ptr, size_t size) {
    if (!size) { _aligned_free(ptr); return NULL; }
    return _aligned_realloc(ptr, size, 64);
}
char *slop_strdup(const char *s) {
    size_t n = strlen(s) + 1;
    char *p = slop_malloc(n);
    if (p) memcpy(p, s, n);
    return p;
}
int posix_memalign(void **ptr, size_t alignment, size_t size) {
    if (alignment < sizeof(void *) || (alignment & (alignment - 1))) return EINVAL;
    void *p = _aligned_malloc(size ? size : 1, alignment);
    if (!p) return ENOMEM;
    *ptr = p;
    return 0;
}
void *slop_aligned_alloc(size_t alignment, size_t size) {
    void *p = NULL;
    int error = posix_memalign(&p, alignment, size);
    if (error) errno = error;
    return p;
}

/* Paths received from Rust and constructed by the engine are UTF-8, independent
 * of the user's Windows ANSI code page. The CRT wide APIs also preserve spaces. */
static wchar_t *wide(const char *s) {
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
    if (!n) { errno = EINVAL; return NULL; }
    wchar_t *w = malloc((size_t)n * sizeof(*w));
    if (w) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, w, n);
    return w;
}
FILE *slop_fopen(const char *path, const char *mode) {
    wchar_t *p = wide(path), *m = wide(mode);
    FILE *f = p && m ? _wfopen(p, m) : NULL;
    free(p); free(m);
    return f;
}
int slop_open(const char *path, int flags) {
    wchar_t *p = wide(path);
    if (!p) return -1;
    int fd = _wopen(p, flags | _O_BINARY);
    free(p);
    return fd;
}
int slop_stat(const char *path, struct slop_stat *st) {
    wchar_t *p = wide(path);
    if (!p) return -1;
    struct _stat64 native;
    int rc = _wstat64(p, &native);
    free(p);
    if (!rc) { st->st_size = native.st_size; st->st_mode = native.st_mode; }
    return rc;
}
int slop_fstat(int fd, struct slop_stat *st) {
    struct _stat64 native;
    int rc = _fstat64(fd, &native);
    if (!rc) { st->st_size = native.st_size; st->st_mode = native.st_mode; }
    return rc;
}
ssize_t pread(int fd, void *buffer, size_t size, int64_t offset) {
    if (offset < 0) { errno = EINVAL; return -1; }
    OVERLAPPED at = {0};
    at.Offset = (DWORD)(uint64_t)offset;
    at.OffsetHigh = (DWORD)((uint64_t)offset >> 32);
    DWORD got = 0;
    DWORD length = size > MAXDWORD ? MAXDWORD : (DWORD)size;
    if (!ReadFile((HANDLE)_get_osfhandle(fd), buffer, length, &got, &at)) {
        if (GetLastError() == ERROR_HANDLE_EOF) return 0;
        errno = EIO; return -1;
    }
    return got;
}
void *mmap(void *address, size_t size, int protection, int flags, int fd, int64_t offset) {
    if (address || !size || protection != PROT_READ || flags != MAP_PRIVATE || offset != 0) {
        errno = EINVAL; return MAP_FAILED;
    }
    HANDLE mapping = CreateFileMappingW((HANDLE)_get_osfhandle(fd), NULL, PAGE_READONLY, 0, 0, NULL);
    if (!mapping) { errno = EIO; return MAP_FAILED; }
    void *view = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, size);
    CloseHandle(mapping);
    if (!view) { errno = ENOMEM; return MAP_FAILED; }
    return view;
}
int munmap(void *address, size_t size) {
    (void)size;
    if (UnmapViewOfFile(address)) return 0;
    errno = EINVAL; return -1;
}
DIR *opendir(const char *path) {
    wchar_t *p = wide(path);
    if (!p) return NULL;
    size_t n = wcslen(p);
    wchar_t *pattern = malloc((n + 3) * sizeof(*pattern));
    DIR *d = calloc(1, sizeof(*d));
    if (!pattern || !d) { free(p); free(pattern); free(d); return NULL; }
    memcpy(pattern, p, n * sizeof(*p));
    pattern[n] = L'/'; pattern[n + 1] = L'*'; pattern[n + 2] = 0;
    d->handle = FindFirstFileW(pattern, &d->data);
    free(p); free(pattern);
    if (d->handle == INVALID_HANDLE_VALUE) { free(d); errno = ENOENT; return NULL; }
    d->first = 1;
    return d;
}
struct dirent *readdir(DIR *d) {
    if (!d->first && !FindNextFileW(d->handle, &d->data)) return NULL;
    d->first = 0;
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, d->data.cFileName, -1,
                            d->entry.d_name, sizeof(d->entry.d_name), NULL, NULL)) {
        errno = EINVAL; return NULL;
    }
    return &d->entry;
}
int closedir(DIR *d) { FindClose(d->handle); free(d); return 0; }

int gettimeofday(struct timeval *tv, void *tz) {
    (void)tz;
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    uint64_t ticks = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    ticks -= 116444736000000000ULL;
    tv->tv_sec = (int64_t)(ticks / 10000000);
    tv->tv_usec = (long)((ticks % 10000000) / 10);
    return 0;
}
int clock_gettime(int clock, struct timespec *ts) {
    if (clock != CLOCK_MONOTONIC) { errno = EINVAL; return -1; }
    LARGE_INTEGER counter, frequency;
    QueryPerformanceCounter(&counter); QueryPerformanceFrequency(&frequency);
    ts->tv_sec = counter.QuadPart / frequency.QuadPart;
    ts->tv_nsec = (long)((counter.QuadPart % frequency.QuadPart) * 1000000000 / frequency.QuadPart);
    return 0;
}
int nanosleep(const struct timespec *duration, struct timespec *remaining) {
    if (duration->tv_sec < 0 || duration->tv_nsec < 0 || duration->tv_nsec >= 1000000000) {
        errno = EINVAL; return -1;
    }
    Sleep((DWORD)(duration->tv_sec * 1000 + (duration->tv_nsec + 999999) / 1000000));
    if (remaining) memset(remaining, 0, sizeof(*remaining));
    return 0;
}

typedef struct { void *(*fn)(void *); void *arg; } start_info;
static unsigned __stdcall start_thread(void *arg) {
    start_info info = *(start_info *)arg;
    free(arg);
    info.fn(info.arg);
    return 0;
}
int pthread_create(pthread_t *thread, const void *attr, void *(*fn)(void *), void *arg) {
    (void)attr;
    start_info *info = malloc(sizeof(*info));
    if (!info) return ENOMEM;
    info->fn = fn; info->arg = arg;
    uintptr_t handle = _beginthreadex(NULL, 0, start_thread, info, 0, NULL);
    if (!handle) { free(info); return EAGAIN; }
    *thread = (HANDLE)handle;
    return 0;
}
int pthread_join(pthread_t thread, void **result) {
    /* Every upstream join discards the thread's return value. */
    if (result) return EINVAL;
    if (WaitForSingleObject(thread, INFINITE) != WAIT_OBJECT_0) return EINVAL;
    CloseHandle(thread);
    return 0;
}
static BOOL CALLBACK call_once(PINIT_ONCE once, PVOID arg, PVOID *context) {
    (void)once; (void)context;
    void (*fn)(void) = *(void (**)(void))arg;
    fn(); return TRUE;
}
int pthread_once(pthread_once_t *once, void (*fn)(void)) {
    return InitOnceExecuteOnce(once, call_once, &fn, NULL) ? 0 : EINVAL;
}

/* clang's CPU builtins otherwise require compiler-rt's __cpu_model on MSVC.
 * Check OS XSAVE support too, before dispatching any AVX/AVX512 kernel. */
int slop_cpu_supports(const char *feature) {
    int leaf[4];
    __cpuid(leaf, 0);
    int max = leaf[0];
    if (max < 1) return 0;
    __cpuidex(leaf, 1, 0);
    unsigned ecx = (unsigned)leaf[2];
    if ((ecx & (1u << 27)) == 0 || (ecx & (1u << 28)) == 0) return 0;
    uint64_t xcr = _xgetbv(0);
    if ((xcr & 6) != 6) return 0;
    if (!strcmp(feature, "avx")) return 1;
    if (!strcmp(feature, "fma")) return (ecx >> 12) & 1;
    if (max < 7) return 0;
    __cpuidex(leaf, 7, 0);
    unsigned ebx = (unsigned)leaf[1], ecx7 = (unsigned)leaf[2];
    int subleaves = leaf[0];
    if (!strcmp(feature, "avx2")) return (ebx >> 5) & 1;
    if ((xcr & 0xe6) != 0xe6 || !(ebx & (1u << 16))) return 0;
    if (!strcmp(feature, "avx512f")) return 1;
    if (!strcmp(feature, "avx512bw")) return (ebx >> 30) & 1;
    if (!strcmp(feature, "avx512vnni")) return (ecx7 >> 11) & 1;
    if (!strcmp(feature, "avx512bf16") && subleaves >= 1) {
        __cpuidex(leaf, 7, 1);
        return ((unsigned)leaf[0] >> 5) & 1;
    }
    return 0;
}
