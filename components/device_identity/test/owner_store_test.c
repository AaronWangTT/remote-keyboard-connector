#include "owner_store.h"

#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

static const uint32_t iterations = 100000;
static const owner_record_t candidate = {.version = 1, .iterations = 100000, .salt = {1}, .digest = {2}};

typedef struct {
    bool consumed;
    uint8_t marker;
    bool owned;
    owner_record_t owner;
} persisted_t;

typedef struct {
    persisted_t durable;
    persisted_t pending;
    bool immediate;
    bool fail_after;
    unsigned failure;
    unsigned calls;
    unsigned read_failure;
    unsigned consumed_reads;
} test_store_t;

static owner_store_result_t read_owner(void *argument, owner_record_t *owner)
{
    test_store_t *store = argument;
    if (store->read_failure == 1) return OWNER_STORE_ERROR;
    if (!store->durable.owned) return OWNER_STORE_NOT_FOUND;
    *owner = store->durable.owner;
    return OWNER_STORE_OK;
}

static owner_store_result_t read_consumed(void *argument, uint8_t *marker)
{
    test_store_t *store = argument;
    store->consumed_reads++;
    if (store->read_failure == 2) return OWNER_STORE_ERROR;
    if (!store->durable.consumed) return OWNER_STORE_NOT_FOUND;
    *marker = store->durable.marker;
    return OWNER_STORE_OK;
}

static bool before_operation(test_store_t *store)
{
    store->calls++;
    return store->calls != store->failure || store->fail_after;
}

static owner_store_result_t after_operation(const test_store_t *store)
{
    return store->calls == store->failure ? OWNER_STORE_ERROR : OWNER_STORE_OK;
}

static owner_store_result_t write_consumed(void *argument)
{
    test_store_t *store = argument;
    if (!before_operation(store)) return OWNER_STORE_ERROR;
    store->pending.consumed = true;
    store->pending.marker = 1;
    if (store->immediate) store->durable = store->pending;
    return after_operation(store);
}

static owner_store_result_t write_owner(void *argument, const owner_record_t *owner)
{
    test_store_t *store = argument;
    assert(store->durable.consumed && store->durable.marker == 1);
    assert(store->calls == 2);
    if (!before_operation(store)) return OWNER_STORE_ERROR;
    store->pending.owned = true;
    store->pending.owner = *owner;
    if (store->immediate) store->durable = store->pending;
    return after_operation(store);
}

static owner_store_result_t commit(void *argument)
{
    test_store_t *store = argument;
    if (!before_operation(store)) return OWNER_STORE_ERROR;
    store->durable = store->pending;
    return after_operation(store);
}

static owner_store_t adapter(test_store_t *context)
{
    return (owner_store_t){.context = context, .read_owner = read_owner, .read_consumed = read_consumed,
        .write_consumed = write_consumed, .write_owner = write_owner, .commit = commit};
}

static void reboot(test_store_t *store)
{
    store->pending = store->durable;
    store->calls = 0;
    store->failure = 0;
    store->read_failure = 0;
}

static void check_reboot(test_store_t *context, owner_store_t *store)
{
    reboot(context);
    owner_record_t loaded = candidate;
    owner_store_result_t result = owner_store_load(store, iterations, &loaded);
    if (context->durable.owned) {
        assert(context->durable.consumed && result == OWNER_STORE_OK);
        assert(memcmp(&loaded, &candidate, sizeof(loaded)) == 0);
        context->durable.owned = false;
        reboot(context);
        assert(owner_store_load(store, iterations, &loaded) == OWNER_STORE_INVALID_STATE);
        assert(loaded.version == 0);
    } else if (context->durable.consumed) {
        assert(result == OWNER_STORE_INVALID_STATE && loaded.version == 0);
    } else {
        assert(result == OWNER_STORE_OK && loaded.version == 0);
    }
}

int main(void)
{
    for (unsigned immediate = 0; immediate < 2; immediate++) {
        for (unsigned after = 0; after < 2; after++) {
            for (unsigned failure = 0; failure <= 4; failure++) {
                test_store_t context = {.immediate = immediate != 0, .fail_after = after != 0, .failure = failure};
                owner_store_t store = adapter(&context);
                assert(owner_store_claim(&store, iterations, &candidate) == (failure ? OWNER_STORE_ERROR : OWNER_STORE_OK));
                assert(context.calls == (failure ? failure : 4));
                check_reboot(&context, &store);
            }
        }
    }
    for (unsigned failure = 0; failure <= 2; failure++) {
        test_store_t context = {.durable = {.owned = true, .owner = candidate}, .failure = failure};
        context.pending = context.durable;
        owner_store_t store = adapter(&context);
        owner_record_t loaded;
        assert(owner_store_load(&store, iterations, &loaded) == (failure ? OWNER_STORE_ERROR : OWNER_STORE_OK));
        assert(loaded.version == (failure ? 0U : 1U));
        reboot(&context);
        assert(owner_store_load(&store, iterations, &loaded) == OWNER_STORE_OK);
        assert(context.durable.consumed && loaded.version == 1);
        context.durable.owned = false;
        assert(owner_store_load(&store, iterations, &loaded) == OWNER_STORE_INVALID_STATE);
    }
    test_store_t context = {0};
    owner_store_t store = adapter(&context);
    owner_record_t loaded = candidate;
    assert(owner_store_load(&store, iterations, &loaded) == OWNER_STORE_OK && loaded.version == 0 && context.calls == 0);
    for (unsigned failure = 1; failure <= 2; failure++) {
        context.read_failure = failure;
        loaded = candidate;
        assert(owner_store_load(&store, iterations, &loaded) == OWNER_STORE_ERROR && loaded.version == 0 && context.calls == 0);
    }
    context.read_failure = 0;
    context.durable = (persisted_t){.consumed = true, .marker = 2, .owned = true, .owner = candidate};
    assert(owner_store_load(&store, iterations, &loaded) == OWNER_STORE_INVALID_STATE);
    context.durable.marker = 1;
    context.durable.owner.version = 2;
    unsigned consumed_reads = context.consumed_reads;
    assert(owner_store_load(&store, iterations, &loaded) == OWNER_STORE_INVALID_VERSION);
    assert(context.consumed_reads == consumed_reads && loaded.version == 0);
    context.durable.owner = candidate;
    context.durable.owner.iterations--;
    assert(owner_store_load(&store, iterations, &loaded) == OWNER_STORE_INVALID_VERSION);
    assert(context.consumed_reads == consumed_reads && loaded.version == 0);
    assert(owner_store_claim(&store, iterations, &context.durable.owner) == OWNER_STORE_INVALID_VERSION && context.calls == 0);
    assert(owner_store_load(NULL, iterations, &loaded) == OWNER_STORE_INVALID_STATE);
    assert(owner_store_load(&store, iterations, NULL) == OWNER_STORE_INVALID_STATE);
    assert(owner_store_claim(NULL, iterations, &candidate) == OWNER_STORE_INVALID_STATE);
    puts("owner_store: claim commit ordering, interrupted writes, owner loss, legacy migration, invalid records and storage failures passed");
    return 0;
}