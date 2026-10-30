#pragma once
#include "compat.h"
struct dirent { char d_name[4 * MAX_PATH]; };
typedef struct { HANDLE handle; WIN32_FIND_DATAW data; int first; struct dirent entry; } DIR;
DIR *opendir(const char *path);
struct dirent *readdir(DIR *dir);
int closedir(DIR *dir);
