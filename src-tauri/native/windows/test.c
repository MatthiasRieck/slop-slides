/* Called only by Rust's Windows regression test; discarded from release links. */
#include "compat.h"
#include "pthread.h"
#include "dirent.h"
#include "sys/mman.h"
#include "qwen_tts_thread.h"
#include <stdatomic.h>
#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

int slop_windows_mark_sparse(void *handle) {
    DWORD returned;
    return DeviceIoControl(handle, 0x000900c4 /* FSCTL_SET_SPARSE */, NULL, 0,
                           NULL, 0, &returned, NULL) ? 0 : (int)GetLastError();
}

static pthread_once_t once = PTHREAD_ONCE_INIT;
static int once_calls;
static void init_once(void) { once_calls++; }
static void count_task(size_t tid, size_t nt, void *context) {
    (void)tid; (void)nt;
    atomic_fetch_add((_Atomic int *)context, 1);
}
static void *submit(void *arg) {
    pthread_once(&once, init_once);
    for (int i = 0; i < 1000; ++i) qwen_parallel(16, count_task, arg);
    return NULL;
}
int slop_windows_regression(const char *dir, const char *file) {
    void *p = malloc(17);
    CHECK(p && (uintptr_t)p % 64 == 0);
    memset(p, 42, 17);
    p = realloc(p, 129);
    CHECK(p && (uintptr_t)p % 64 == 0 && ((char *)p)[16] == 42);
    free(p);
    CHECK(posix_memalign(&p, 64, 193) == 0);
    free(p);
    p = aligned_alloc(64, 256); CHECK(p); free(p);
    char *copy = strdup("test"); CHECK(copy && !strcmp(copy, "test")); free(copy);
    struct stat st;
    CHECK(stat(file, &st) == 0 && st.st_size > INT32_MAX);
    FILE *f = fopen(file, "rb"); CHECK(f); fclose(f);
    int fd = open(file, O_RDONLY); CHECK(fd >= 0);
    CHECK(fstat(fd, &st) == 0 && st.st_size > INT32_MAX);
    char bytes[4];
    CHECK(pread(fd, bytes, 4, (int64_t)st.st_size - 4) == 4 && !memcmp(bytes, "tail", 4));
    unsigned char *map = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    CHECK(map != MAP_FAILED && !memcmp(map + st.st_size - 4, "tail", 4));
    CHECK(munmap(map, (size_t)st.st_size) == 0);
    close(fd);
    DIR *d = opendir(dir); CHECK(d);
    int found = 0;
    struct dirent *entry;
    while ((entry = readdir(d))) if (!strcmp(entry->d_name, "model \xc3\xa4.bin")) found = 1;
    closedir(d); CHECK(found);
    struct timespec before, after, pause = {0, 1000000};
    CHECK(clock_gettime(CLOCK_MONOTONIC, &before) == 0);
    CHECK(nanosleep(&pause, NULL) == 0);
    CHECK(clock_gettime(CLOCK_MONOTONIC, &after) == 0);
    CHECK(after.tv_sec > before.tv_sec || (after.tv_sec == before.tv_sec && after.tv_nsec >= before.tv_nsec));
    CHECK(qwen_pool_concurrent_submit_ok());
    qwen_threadpool_start(4);
    _Atomic int count = 0;
    pthread_t a, b;
    CHECK(pthread_create(&a, NULL, submit, &count) == 0);
    CHECK(pthread_create(&b, NULL, submit, &count) == 0);
    CHECK(pthread_join(a, NULL) == 0 && pthread_join(b, NULL) == 0);
    qwen_threadpool_stop();
    CHECK(count == 32000 && once_calls == 1);
    return 0;
}
