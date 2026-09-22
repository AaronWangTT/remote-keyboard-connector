#include "wakeup_policy.h"

#include <string.h>

bool wakeup_source_allowed(uint32_t ipv4_host_order)
{
    return ipv4_host_order == UINT32_C(0xc0a80102);
}

bool wakeup_origin_allowed(const char *origin)
{
    return origin == NULL ||
           strcmp(origin, "http://192.168.1.2") == 0 ||
           strcmp(origin, "http://192.168.1.2:80") == 0;
}
