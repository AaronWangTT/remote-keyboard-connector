#include "wakeup_policy.h"

#include <assert.h>
#include <stdio.h>

int main(void)
{
    assert(wakeup_source_allowed(UINT32_C(0xc0a80102)));
    assert(!wakeup_source_allowed(UINT32_C(0xc0a80101)));
    assert(!wakeup_source_allowed(UINT32_C(0x0a000002)));

    assert(wakeup_origin_allowed(NULL));
    assert(wakeup_origin_allowed("http://192.168.1.2"));
    assert(wakeup_origin_allowed("http://192.168.1.2:80"));
    assert(!wakeup_origin_allowed(""));
    assert(!wakeup_origin_allowed("https://192.168.1.2"));
    assert(!wakeup_origin_allowed("http://192.168.1.20"));
    assert(!wakeup_origin_allowed("http://istoreos"));

    assert(wakeup_body_allowed(0, false));
    assert(!wakeup_body_allowed(1, false));
    assert(!wakeup_body_allowed(0, true));
    assert(!wakeup_body_allowed(1, true));

    puts("wakeup_policy: source IPv4, optional Origin, and empty-body checks passed");
    return 0;
}
