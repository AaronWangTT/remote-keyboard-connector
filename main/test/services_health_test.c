#include <assert.h>
#include <stdbool.h>
#include <stdio.h>

static bool network_healthy, web_healthy, usb_healthy;
static bool network_service_healthy(void) { return network_healthy; }
static bool web_server_service_healthy(void) { return web_healthy; }
static bool usb_keyboard_service_healthy(void) { return usb_healthy; }

#include "services_health.inc"

int main(void)
{
    for (unsigned combination = 0; combination < 8; combination++) {
        network_healthy = (combination & 1) != 0;
        web_healthy = (combination & 2) != 0;
        usb_healthy = (combination & 4) != 0;
        assert(services_healthy() == (combination == 7));
    }
    puts("PASS: OTA service health queries need no full network snapshot");
    return 0;
}
