#include "owner_store.h"

#include <stdbool.h>
#include <string.h>

static bool store_valid(const owner_store_t *store)
{
    return store != NULL && store->read_owner != NULL && store->read_consumed != NULL &&
           store->write_consumed != NULL && store->write_owner != NULL && store->commit != NULL;
}

static owner_store_result_t consume_claim(const owner_store_t *store)
{
    owner_store_result_t result = store->write_consumed(store->context);
    return result == OWNER_STORE_OK ? store->commit(store->context) : result;
}

owner_store_result_t owner_store_load(const owner_store_t *store, uint32_t iterations, owner_record_t *owner)
{
    if (owner == NULL) return OWNER_STORE_INVALID_STATE;
    memset(owner, 0, sizeof(*owner));
    if (!store_valid(store)) return OWNER_STORE_INVALID_STATE;
    owner_record_t loaded = {0};
    owner_store_result_t result = store->read_owner(store->context, &loaded);
    bool present = result == OWNER_STORE_OK;
    if (!present && result != OWNER_STORE_NOT_FOUND) return result;
    if (present && (loaded.version != 1 || loaded.iterations != iterations)) return OWNER_STORE_INVALID_VERSION;
    uint8_t consumed = 0;
    result = store->read_consumed(store->context, &consumed);
    if (result == OWNER_STORE_NOT_FOUND) {
        result = present ? consume_claim(store) : OWNER_STORE_OK;
    } else if (result == OWNER_STORE_OK && (consumed != 1 || !present)) {
        result = OWNER_STORE_INVALID_STATE;
    }
    if (result == OWNER_STORE_OK && present) *owner = loaded;
    return result;
}

owner_store_result_t owner_store_claim(const owner_store_t *store, uint32_t iterations, const owner_record_t *owner)
{
    if (!store_valid(store) || owner == NULL) return OWNER_STORE_INVALID_STATE;
    if (owner->version != 1 || owner->iterations != iterations) return OWNER_STORE_INVALID_VERSION;
    owner_store_result_t result = consume_claim(store);
    if (result == OWNER_STORE_OK) result = store->write_owner(store->context, owner);
    return result == OWNER_STORE_OK ? store->commit(store->context) : result;
}