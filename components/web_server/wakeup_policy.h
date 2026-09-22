#pragma once

#include <stdbool.h>
#include <stdint.h>

bool wakeup_source_allowed(uint32_t ipv4_host_order);
bool wakeup_origin_allowed(const char *origin);
