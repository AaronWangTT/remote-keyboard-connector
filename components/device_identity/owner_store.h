#pragma once

#include <stdint.h>

typedef struct {
    uint32_t version;
    uint32_t iterations;
    uint8_t salt[16];
    uint8_t digest[32];
} owner_record_t;

typedef enum {
    OWNER_STORE_OK, OWNER_STORE_NOT_FOUND, OWNER_STORE_ERROR,
    OWNER_STORE_INVALID_VERSION, OWNER_STORE_INVALID_STATE
} owner_store_result_t;

typedef struct {
    void *context;
    owner_store_result_t (*read_owner)(void *, owner_record_t *);
    owner_store_result_t (*read_consumed)(void *, uint8_t *);
    owner_store_result_t (*write_consumed)(void *);
    owner_store_result_t (*write_owner)(void *, const owner_record_t *);
    owner_store_result_t (*commit)(void *);
} owner_store_t;

owner_store_result_t owner_store_load(const owner_store_t *store, uint32_t iterations, owner_record_t *owner);
owner_store_result_t owner_store_claim(const owner_store_t *store, uint32_t iterations, const owner_record_t *owner);