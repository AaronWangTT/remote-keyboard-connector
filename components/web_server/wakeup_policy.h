#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool wakeup_source_allowed(uint32_t ipv4_host_order);
bool wakeup_origin_allowed(const char *origin);
bool wakeup_body_allowed(size_t content_length, bool transfer_encoding_present);
