#include "lvgl.h"
#include "drivers/sdl/lv_sdl_mouse.h"
#include "drivers/sdl/lv_sdl_window.h"

#include <SDL.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void tsx_lvgl_ui_create(void);

typedef struct {
    uint8_t *pixels;
    int width;
    int height;
    int pitch;
} Framebuffer;

static size_t count_objects(const lv_obj_t *object)
{
    size_t count = 1U;
    for(uint32_t index = 0; index < lv_obj_get_child_count(object); index++) {
        count += count_objects(lv_obj_get_child(object, (int32_t)index));
    }
    return count;
}

static lv_obj_t *find_clickable(lv_obj_t *object)
{
    if(lv_obj_check_type(object, &lv_button_class)) return object;
    for(uint32_t index = 0; index < lv_obj_get_child_count(object); index++) {
        lv_obj_t *match = find_clickable(lv_obj_get_child(object, (int32_t)index));
        if(match != NULL) return match;
    }
    return NULL;
}

static lv_obj_t *find_label_with_text(lv_obj_t *object, const char *text)
{
    if(lv_obj_check_type(object, &lv_label_class)) {
        const char *label_text = lv_label_get_text(object);
        if(label_text != NULL && strcmp(label_text, text) == 0) return object;
    }
    for(uint32_t index = 0; index < lv_obj_get_child_count(object); index++) {
        lv_obj_t *match = find_label_with_text(lv_obj_get_child(object, (int32_t)index), text);
        if(match != NULL) return match;
    }
    return NULL;
}

static bool capture_framebuffer(lv_display_t *display, Framebuffer *frame)
{
    SDL_Renderer *renderer = (SDL_Renderer *)lv_sdl_window_get_renderer(display);
    if(renderer == NULL) return false;
    if(SDL_GetRendererOutputSize(renderer, &frame->width, &frame->height) != 0) return false;
    frame->pitch = frame->width * 4;
    frame->pixels = malloc((size_t)frame->pitch * (size_t)frame->height);
    if(frame->pixels == NULL) return false;
    if(SDL_RenderReadPixels(renderer, NULL, SDL_PIXELFORMAT_RGBA32, frame->pixels, frame->pitch) != 0) {
        free(frame->pixels);
        frame->pixels = NULL;
        return false;
    }
    return true;
}

static void release_framebuffer(Framebuffer *frame)
{
    free(frame->pixels);
    frame->pixels = NULL;
}

static uint64_t framebuffer_hash(const Framebuffer *frame)
{
    uint64_t hash = UINT64_C(1469598103934665603);
    const size_t byte_count = (size_t)frame->pitch * (size_t)frame->height;
    for(size_t index = 0; index < byte_count; index++) {
        hash ^= frame->pixels[index];
        hash *= UINT64_C(1099511628211);
    }
    return hash;
}

static bool write_screenshot(const Framebuffer *frame, const char *path)
{
    FILE *file = fopen(path, "wb");
    if(file == NULL) return false;
    fprintf(file, "P6\n%d %d\n255\n", frame->width, frame->height);
    for(int y = 0; y < frame->height; y++) {
        for(int x = 0; x < frame->width; x++) {
            const uint8_t *pixel = frame->pixels + (size_t)y * (size_t)frame->pitch + (size_t)x * 4U;
            if(fwrite(pixel, 1, 3, file) != 3U) {
                fclose(file);
                return false;
            }
        }
    }
    return fclose(file) == 0;
}

static bool push_mouse_event(const SDL_Event *event)
{
    return SDL_PushEvent((SDL_Event *)event) == 1;
}

static bool inject_click(lv_display_t *display, lv_obj_t *target)
{
    SDL_Window *window = lv_sdl_window_get_window(display);
    if(window == NULL) return false;

    lv_area_t coords;
    lv_obj_get_coords(target, &coords);
    const int x = (coords.x1 + coords.x2) / 2;
    const int y = (coords.y1 + coords.y2) / 2;
    const uint32_t window_id = SDL_GetWindowID(window);

    SDL_Event event;
    memset(&event, 0, sizeof(event));
    event.type = SDL_MOUSEMOTION;
    event.motion.windowID = window_id;
    event.motion.x = x;
    event.motion.y = y;
    if(!push_mouse_event(&event)) return false;

    memset(&event, 0, sizeof(event));
    event.type = SDL_MOUSEBUTTONDOWN;
    event.button.windowID = window_id;
    event.button.button = SDL_BUTTON_LEFT;
    event.button.x = x;
    event.button.y = y;
    if(!push_mouse_event(&event)) return false;

    memset(&event, 0, sizeof(event));
    event.type = SDL_MOUSEBUTTONUP;
    event.button.windowID = window_id;
    event.button.button = SDL_BUTTON_LEFT;
    event.button.x = x;
    event.button.y = y;
    if(!push_mouse_event(&event)) return false;

    /* lv_sdl_window's timer drains SDL's queue and routes the events through
       lv_sdl_mouse_handler, which performs the normal LVGL hit-test. */
    for(int attempt = 0; attempt < 20; attempt++) {
        SDL_Delay(2);
        (void)lv_timer_handler();
    }
    return true;
}

static int run_interaction_test(lv_display_t *display)
{
    enum {
        WARMUP_BATCHES = 2,
        STEADY_STATE_BATCHES = 8,
        CLICKS_PER_BATCH = 4,
    };
    const uint32_t heap_jitter_tolerance_bytes = 64U;
    const char *screenshot_directory = getenv("TSX_LVGL_SCREENSHOT_DIR");
    if(screenshot_directory == NULL) screenshot_directory = ".";

    (void)lv_timer_handler();
    lv_refr_now(display);
    lv_obj_t *screen = lv_screen_active();
    lv_obj_t *button = find_clickable(screen);
    lv_obj_t *zero_label = find_label_with_text(screen, "0");
    if(button == NULL || zero_label == NULL) return 10;
    const size_t object_count_before = count_objects(screen);

    char before_path[512];
    char after_path[512];
    (void)snprintf(before_path, sizeof(before_path), "%s/counter-before.ppm", screenshot_directory);
    (void)snprintf(after_path, sizeof(after_path), "%s/counter-after.ppm", screenshot_directory);

    Framebuffer before = {0};
    if(!capture_framebuffer(display, &before) || !write_screenshot(&before, before_path)) {
        release_framebuffer(&before);
        return 11;
    }

    if(!inject_click(display, button)) {
        release_framebuffer(&before);
        return 12;
    }
    lv_refr_now(display);
    lv_obj_t *one_label = find_label_with_text(screen, "1");
    Framebuffer after = {0};
    if(one_label == NULL || !capture_framebuffer(display, &after) || !write_screenshot(&after, after_path)) {
        release_framebuffer(&before);
        release_framebuffer(&after);
        return 13;
    }
    if(framebuffer_hash(&before) == framebuffer_hash(&after)) {
        release_framebuffer(&before);
        release_framebuffer(&after);
        return 14;
    }
    release_framebuffer(&before);
    release_framebuffer(&after);

    for(int repeat = 0; repeat < 3; repeat++) {
        if(!inject_click(display, button)) return 15;
    }
    lv_obj_t *four_label = find_label_with_text(screen, "4");
    if(four_label == NULL) return 16;
    for(int repeat = 0; repeat < 3; repeat++) {
        if(!inject_click(display, button)) return 17;
    }
    if(find_label_with_text(screen, "7") == NULL) return 18;

    /* Let the UI and SDL allocator settle before taking steady-state samples. */
    for(int batch = 0; batch < WARMUP_BATCHES; batch++) {
        for(int repeat = 0; repeat < CLICKS_PER_BATCH; repeat++) {
            if(!inject_click(display, button)) return 19;
        }
    }
    if(find_label_with_text(screen, "15") == NULL) return 20;

    lv_mem_monitor_t warmup_memory;
    lv_mem_monitor(&warmup_memory);
    const uint32_t expected_used_count = warmup_memory.used_cnt;
    uint32_t used_samples[STEADY_STATE_BATCHES];
    uint32_t minimum_used_bytes = UINT32_MAX;
    uint32_t maximum_used_bytes = 0U;
    for(int batch = 0; batch < STEADY_STATE_BATCHES; batch++) {
        for(int repeat = 0; repeat < CLICKS_PER_BATCH; repeat++) {
            if(!inject_click(display, button)) return 21;
        }
        lv_mem_monitor_t memory;
        lv_mem_monitor(&memory);
        const uint32_t used_bytes = memory.total_size - memory.free_size;
        used_samples[batch] = used_bytes;
        if(used_bytes < minimum_used_bytes) minimum_used_bytes = used_bytes;
        if(used_bytes > maximum_used_bytes) maximum_used_bytes = used_bytes;
        if(count_objects(screen) != object_count_before) return 22;
        if(memory.used_cnt != expected_used_count) return 23;
    }
    const uint32_t used_range = maximum_used_bytes - minimum_used_bytes;
    if(used_range > heap_jitter_tolerance_bytes) return 24;
    if(maximum_used_bytes > used_samples[0] + heap_jitter_tolerance_bytes) return 25;

    printf("steady-state heap samples (used bytes=total_size-free_size): [");
    for(int batch = 0; batch < STEADY_STATE_BATCHES; batch++) {
        printf("%s%u", batch == 0 ? "" : ", ", (unsigned)used_samples[batch]);
    }
    printf("] range=%u..%u delta=%u tolerance=%u bytes across %u batches of %u clicks\n",
           (unsigned)minimum_used_bytes,
           (unsigned)maximum_used_bytes,
           (unsigned)used_range,
           (unsigned)heap_jitter_tolerance_bytes,
           (unsigned)STEADY_STATE_BATCHES,
           (unsigned)CLICKS_PER_BATCH);

    puts("SDL interaction passed: real SDL pointer events hit button; label 0 -> 1; framebuffer changed; repeated events -> 7; object count fixed; heap growth bounded within allocator-jitter tolerance");
    printf("screenshots: %s, %s\n", before_path, after_path);
    return 0;
}

int main(void)
{
    lv_init();
    lv_display_t *display = lv_sdl_window_create(368, 448);
    if(display == NULL) {
        fprintf(stderr, "SDL display creation failed: %s\n", SDL_GetError());
        return 2;
    }
    lv_sdl_window_set_title(display, "TSX-LVGL SDL 9.5.0");
    if(lv_sdl_mouse_create() == NULL) return 3;
    tsx_lvgl_ui_create();

    const bool test_mode = getenv("TSX_LVGL_TEST") != NULL;
    if(test_mode) return run_interaction_test(display);

    while(true) {
        const uint32_t wait_ms = lv_timer_handler();
        SDL_Delay(wait_ms > 10U ? 10U : wait_ms);
    }
}
