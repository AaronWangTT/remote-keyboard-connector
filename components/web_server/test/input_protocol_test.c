#include "input_protocol.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static bool parse(const char *json, input_message_t *message)
{
    return input_message_parse((const uint8_t *)json, strlen(json), message);
}

int main(void)
{
    input_message_t message;
    assert(input_frame_valid(true, true, 256));
    assert(!input_frame_valid(false, true, 4));
    assert(!input_frame_valid(true, false, 4));
    assert(!input_frame_valid(true, true, 0));
    assert(!input_frame_valid(true, true, 257));
    assert(!input_frame_valid(true, true, SIZE_MAX));
    assert(parse("{\"v\":1,\"type\":\"ping\"}", &message) && message.type == INPUT_HEARTBEAT);
    assert(parse("{\"v\":1,\"type\":\"stop\"}", &message) && message.type == INPUT_STOP);
    assert(parse("{\"v\":1,\"type\":\"state\",\"seq\":1,\"modifiers\":2,\"keys\":[29,4,40,42,44,56]}", &message));
    assert(message.type == INPUT_STATE && message.sequence == 1 && message.report.modifiers == 2);
    assert(message.report.keys[0] == 4 && message.report.keys[5] == 56);
    assert(parse("{\"v\":1,\"type\":\"state\",\"seq\":2,\"modifiers\":0,\"keys\":[]}", &message));
    assert(keyboard_report_empty(&message.report));
    const char *invalid[] = {
        "", "down", "null", "{}", "[]", "{\"v\":2,\"type\":\"ping\"}",
        "{\"v\":1,\"v\":1,\"type\":\"ping\"}", "{\"v\":1,\"type\":\"ping\",\"keys\":[]}",
        "{\"v\":true,\"type\":\"ping\"}", "{\"v\":1,\"type\":\"ping\"} {}",
        "{\"v\":1,\"type\":\"state\",\"seq\":0,\"modifiers\":0,\"keys\":[4]}",
        "{\"v\":1,\"type\":\"state\",\"seq\":1.5,\"modifiers\":0,\"keys\":[4]}",
        "{\"v\":1,\"type\":\"state\",\"seq\":2147483648,\"modifiers\":0,\"keys\":[4]}",
        "{\"v\":1,\"type\":\"state\",\"seq\":1,\"modifiers\":1,\"keys\":[4]}",
        "{\"v\":1,\"type\":\"state\",\"seq\":1,\"modifiers\":0,\"keys\":[4,4]}",
        "{\"v\":1,\"type\":\"state\",\"seq\":1,\"modifiers\":0,\"keys\":[4,5,6,7,8,9,10]}",
        "{\"v\":1,\"type\":\"state\",\"seq\":1,\"modifiers\":0,\"keys\":[0]}",
        "{\"v\":1,\"type\":\"state\",\"seq\":1,\"modifiers\":0,\"keys\":[58]}",
        "{\"v\":1,\"type\":\"state\",\"seq\":1,\"modifiers\":0,\"keys\":[-1]}",
        "{\"v\":1,\"type\":\"state\",\"seq\":1,\"modifiers\":0,\"keys\":[1e999]}",
        "{\"v\":1,\"type\":\"state\",\"seq\":1,\"modifiers\":0,\"keys\":[4.1]}",
        "{\"v\":1,\"type\":\"state\",\"seq\":1,\"modifiers\":0,\"keys\":[[[[[[4]]]]]]}",
    };
    for (size_t index = 0; index < sizeof(invalid) / sizeof(invalid[0]); index++) {
        assert(!parse(invalid[index], &message));
        assert(message.type == INPUT_INVALID && keyboard_report_empty(&message.report));
    }
    assert(!input_message_parse(NULL, 4, &message));
    assert(!input_message_parse((const uint8_t *)"{}", SIZE_MAX, &message));
    puts("input_protocol: versioned JSON, schema, report and frame boundaries passed");
    return 0;
}