#include "network_state.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv)
{
    network_profiles_t fixture = {
        .version = 2, .station = 1, .count = 2, .hostname = "fixture-host",
        .profiles = {
            {.ssid = "fixture-main", .password = "fixture-pass", .verified = 1},
            {.ssid = "\xffwifi", .password = "second-pass", .verified = 0},
        },
    };
    assert(network_profiles_valid(&fixture));
    assert(sizeof(fixture) == 1017);
    if (argc == 3 && strcmp(argv[1], "--validate-fixture") == 0) {
        FILE *input = fopen(argv[2], "rb");
        assert(input != NULL);
        network_profiles_t imported;
        size_t length = fread(&imported, 1, sizeof(imported), input);
        int trailing = fgetc(input);
        assert(fclose(input) == 0);
        return length == sizeof(imported) && trailing == EOF && network_profiles_valid(&imported) ? 0 : 1;
    } else if (argc == 3 && strcmp(argv[1], "--emit-fixture") == 0) {
        FILE *output = fopen(argv[2], "wb");
        assert(output != NULL);
        assert(fwrite(&fixture, 1, sizeof(fixture), output) == sizeof(fixture));
        assert(fclose(output) == 0);
    } else assert(argc == 1);
    puts("PASS: portable multi-network NVS fixture");
    return 0;
}
