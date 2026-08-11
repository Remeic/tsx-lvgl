#include "lvgl_host.h"

#include <stddef.h>
#include <stdlib.h>

typedef struct {
    bool used;
    /** The widget itself: the screen/view container, the label, or the button. */
    lv_obj_t *object;
    /** Label text target: `object` for Text, the inner label for Button, NULL otherwise. */
    lv_obj_t *label;
    /** Tracked host parent handle; 0 means the object is a native root. */
    int parent_id;
    bool clickable;
} lvgl_host_entry_t;

struct lvgl_host {
    lvgl_host_entry_t entries[LVGL_HOST_MAX_HANDLES];
    lvgl_host_click_cb_t click_cb;
    void *click_user_data;
    /**
     * Hidden off-screen staging parent: widgets are created here so they are
     * never LVGL screens, then reparented by `insert`; never loaded, never
     * occupies a handle.
     */
    lv_obj_t *staging_screen;
    /** Reusable blank screen for Runtime.unmount; never occupies a host handle. */
    lv_obj_t *blank_screen;
};

/**
 * One `lvgl_host_t` is ever live at a time (the probe owns exactly one). A
 * module-level pointer lets the LVGL click callback — which LVGL invokes
 * with only the `lv_event_t*` and whatever `user_data` was registered —
 * recover the host without heap-allocating a `{host, handle}` pair per
 * clickable widget.
 */
static lvgl_host_t *s_active_host;

static lvgl_host_entry_t *entry_at(lvgl_host_t *host, int id)
{
    if (host == NULL || id <= 0 || (uint32_t)id > LVGL_HOST_MAX_HANDLES) return NULL;
    lvgl_host_entry_t *entry = &host->entries[id - 1];
    return entry->used ? entry : NULL;
}

static void host_click_event_cb(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) return;
    lvgl_host_t *host = s_active_host;
    if (host == NULL || host->click_cb == NULL) return;
    const int handle = (int)(intptr_t)lv_event_get_user_data(event);
    host->click_cb(host->click_user_data, handle);
}

lvgl_host_t *lvgl_host_create(lvgl_host_click_cb_t click_cb, void *click_user_data)
{
    lvgl_host_t *host = calloc(1, sizeof(*host));
    if (host == NULL) return NULL;
    host->click_cb = click_cb;
    host->click_user_data = click_user_data;
    s_active_host = host;
    return host;
}

void lvgl_host_destroy(lvgl_host_t *host)
{
    if (host == NULL) return;
    if (s_active_host == host) s_active_host = NULL;

    /* lv_obj_delete is recursive. Snapshot only tracked roots (true screens,
     * i.e. objects with no LVGL parent) and invalidate the table before
     * deleting anything, otherwise a later child entry would be a dangling
     * pointer after its tracked parent had already deleted it. Widgets still
     * sitting in staging also have parent_id == 0 but are LVGL children of
     * staging_screen, not roots — collecting them here and then deleting
     * staging_screen below would double free them. */
    lv_obj_t *roots[LVGL_HOST_MAX_HANDLES];
    uint32_t root_count = 0;
    for (uint32_t index = 0; index < LVGL_HOST_MAX_HANDLES; index++) {
        lvgl_host_entry_t *entry = &host->entries[index];
        if (entry->used && entry->object != NULL && lv_obj_get_parent(entry->object) == NULL && root_count < LVGL_HOST_MAX_HANDLES) {
            roots[root_count++] = entry->object;
        }
        entry->used = false;
        entry->object = NULL;
        entry->label = NULL;
        entry->parent_id = 0;
        entry->clickable = false;
    }
    for (uint32_t index = 0; index < root_count; index++) lv_obj_delete(roots[index]);
    if (host->blank_screen != NULL) {
        lv_obj_delete(host->blank_screen);
        host->blank_screen = NULL;
    }
    if (host->staging_screen != NULL) {
        lv_obj_delete(host->staging_screen);
        host->staging_screen = NULL;
    }
    free(host);
}

static int allocate_slot(lvgl_host_t *host)
{
    for (uint32_t index = 0; index < LVGL_HOST_MAX_HANDLES; index++) {
        if (!host->entries[index].used) return (int)index;
    }
    return -1;
}

static void invalidate_descendants(lvgl_host_t *host, int parent_id)
{
    for (uint32_t index = 0; index < LVGL_HOST_MAX_HANDLES; index++) {
        lvgl_host_entry_t *descendant = &host->entries[index];
        if (!descendant->used || descendant->parent_id != parent_id) continue;
        const int child_id = (int)index + 1;
        invalidate_descendants(host, child_id);
        descendant->used = false;
        descendant->object = NULL;
        descendant->label = NULL;
        descendant->parent_id = 0;
        descendant->clickable = false;
    }
}

/**
 * Lazily creates the hidden staging screen and returns it. May return NULL
 * on allocation failure; `lv_obj_create(NULL)` would otherwise create a
 * screen, so callers must fail out for non-screen kinds before creating the
 * widget when this returns NULL.
 */
static lv_obj_t *staging_parent(lvgl_host_t *host)
{
    if (host->staging_screen == NULL) {
        host->staging_screen = lv_obj_create(NULL);
        if (host->staging_screen != NULL) lv_obj_add_flag(host->staging_screen, LV_OBJ_FLAG_HIDDEN);
    }
    return host->staging_screen;
}

static void configure_container(lv_obj_t *object)
{
    lv_obj_set_flex_flow(object, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(object, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
}
int lvgl_host_create_widget(lvgl_host_t *host, lvgl_host_widget_kind_t kind)
{
    if (host == NULL) return 0;
    const int slot = allocate_slot(host);
    if (slot < 0) return 0;

    /*
     * A Screen is created parentless, which in LVGL 9 makes it a real
     * screen; it's never reparented. Every other widget is created under
     * the hidden `staging_screen` so it starts life as an ordinary object,
     * then `insert` reparents it under its real parent, matching the
     * reconciler's order of operations (createInstance happens before the
     * parent is known; insertChild follows). A Button's inner label is a
     * private LVGL child, never exposed as its own handle.
     */
    lv_obj_t *object = NULL;
    lv_obj_t *label = NULL;
    switch (kind) {
        case LVGL_HOST_WIDGET_SCREEN:
            object = lv_obj_create(NULL);
            break;
        case LVGL_HOST_WIDGET_VIEW: {
            lv_obj_t *staging = staging_parent(host);
            if (staging == NULL) return 0;
            object = lv_obj_create(staging);
            if (object != NULL) {
                lv_obj_remove_style_all(object);
                lv_obj_remove_flag(object, LV_OBJ_FLAG_SCROLLABLE);
            }
            break;
        }
        case LVGL_HOST_WIDGET_TEXT: {
            lv_obj_t *staging = staging_parent(host);
            if (staging == NULL) return 0;
            object = lv_label_create(staging);
            label = object;
            break;
        }
        case LVGL_HOST_WIDGET_BUTTON: {
            lv_obj_t *staging = staging_parent(host);
            if (staging == NULL) return 0;
            object = lv_button_create(staging);
            if (object != NULL) label = lv_label_create(object);
            if (object == NULL || label == NULL) {
                if (object != NULL) lv_obj_delete(object);
                return 0;
            }
            lv_obj_center(label);
            break;
        }
        default:
            return 0;
    }
    if (object == NULL) return 0;
    if (kind == LVGL_HOST_WIDGET_SCREEN || kind == LVGL_HOST_WIDGET_VIEW) configure_container(object);

    lvgl_host_entry_t *entry = &host->entries[slot];
    entry->used = true;
    entry->object = object;
    entry->label = label;
    entry->parent_id = 0;
    entry->clickable = false;
    return slot + 1;
}

void lvgl_host_insert(lvgl_host_t *host, int parent, int child, int32_t index)
{
    lvgl_host_entry_t *parent_entry = entry_at(host, parent);
    lvgl_host_entry_t *child_entry = entry_at(host, child);
    if (parent_entry == NULL || child_entry == NULL) return;
    lv_obj_set_parent(child_entry->object, parent_entry->object);
    lv_obj_move_to_index(child_entry->object, index);
    child_entry->parent_id = parent;
}

void lvgl_host_set_text(lvgl_host_t *host, int id, const char *text)
{
    lvgl_host_entry_t *entry = entry_at(host, id);
    if (entry == NULL || entry->label == NULL || text == NULL) return;
    lv_label_set_text(entry->label, text);
}

void lvgl_host_set_clickable(lvgl_host_t *host, int id, bool clickable)
{
    lvgl_host_entry_t *entry = entry_at(host, id);
    if (entry == NULL || entry->object == NULL || entry->clickable == clickable) return;
    if (clickable) {
        lv_obj_add_flag(entry->object, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_event_cb(entry->object, host_click_event_cb, LV_EVENT_CLICKED, (void *)(intptr_t)id);
    } else {
        lv_obj_remove_event_cb(entry->object, host_click_event_cb);
        lv_obj_remove_flag(entry->object, LV_OBJ_FLAG_CLICKABLE);
    }
    entry->clickable = clickable;
}

void lvgl_host_remove(lvgl_host_t *host, int parent, int child)
{
    /* No-op by design; see the doc comment on the declaration in lvgl_host.h. */
    (void)host;
    (void)parent;
    (void)child;
}

void lvgl_host_dispose(lvgl_host_t *host, int id)
{
    lvgl_host_entry_t *entry = entry_at(host, id);
    if (entry == NULL) return;
    if (entry->object != NULL) lv_obj_delete(entry->object);
    entry->used = false;
    entry->object = NULL;
    entry->label = NULL;
    entry->parent_id = 0;
    entry->clickable = false;

    /* The runtime normally disposes descendants first, but the native ABI is
     * recursive by contract. Invalidate any still-tracked descendants so a
     * later defensive dispose cannot call lv_obj_delete on freed memory. */
    invalidate_descendants(host, id);
}

/** COLOR/TEXT_ALIGN target the inner label when present (Button), else the object itself. */
static lv_obj_t *style_target(lvgl_host_entry_t *entry, int prop)
{
    if (prop == LVGL_HOST_STYLE_COLOR || prop == LVGL_HOST_STYLE_TEXT_ALIGN) {
        return entry->label != NULL ? entry->label : entry->object;
    }
    return entry->object;
}

void lvgl_host_set_style(lvgl_host_t *host, int id, int prop, int32_t value)
{
    lvgl_host_entry_t *entry = entry_at(host, id);
    if (entry == NULL) return;
    lv_obj_t *target = style_target(entry, prop);
    if (target == NULL) return;

    switch (prop) {
        case LVGL_HOST_STYLE_BACKGROUND_COLOR:
            lv_obj_set_style_bg_color(target, lv_color_hex((uint32_t)value & 0xFFFFFFu), 0);
            lv_obj_set_style_bg_opa(target, LV_OPA_COVER, 0);
            break;
        case LVGL_HOST_STYLE_BORDER_COLOR:
            lv_obj_set_style_border_color(target, lv_color_hex((uint32_t)value & 0xFFFFFFu), 0);
            break;
        case LVGL_HOST_STYLE_BORDER_WIDTH:
            lv_obj_set_style_border_width(target, value, 0);
            break;
        case LVGL_HOST_STYLE_BORDER_RADIUS:
            lv_obj_set_style_radius(target, value > LV_RADIUS_CIRCLE ? LV_RADIUS_CIRCLE : value, 0);
            break;
        case LVGL_HOST_STYLE_PADDING_TOP:
            lv_obj_set_style_pad_top(target, value, 0);
            break;
        case LVGL_HOST_STYLE_PADDING_RIGHT:
            lv_obj_set_style_pad_right(target, value, 0);
            break;
        case LVGL_HOST_STYLE_PADDING_BOTTOM:
            lv_obj_set_style_pad_bottom(target, value, 0);
            break;
        case LVGL_HOST_STYLE_PADDING_LEFT:
            lv_obj_set_style_pad_left(target, value, 0);
            break;
        case LVGL_HOST_STYLE_COLOR:
            lv_obj_set_style_text_color(target, lv_color_hex((uint32_t)value & 0xFFFFFFu), 0);
            break;
        case LVGL_HOST_STYLE_TEXT_ALIGN: {
            lv_text_align_t align = LV_TEXT_ALIGN_LEFT;
            if (value == 1) align = LV_TEXT_ALIGN_CENTER;
            else if (value == 2) align = LV_TEXT_ALIGN_RIGHT;
            lv_obj_set_style_text_align(target, align, 0);
            break;
        }
        default:
            /* Unknown codes are rejected at the binding layer; ignore defensively. */
            break;
    }
}

void lvgl_host_reset_style(lvgl_host_t *host, int id, int prop)
{
    lvgl_host_entry_t *entry = entry_at(host, id);
    if (entry == NULL) return;
    lv_obj_t *target = style_target(entry, prop);
    if (target == NULL) return;

    switch (prop) {
        case LVGL_HOST_STYLE_BACKGROUND_COLOR:
            lv_obj_remove_local_style_prop(target, LV_STYLE_BG_COLOR, 0);
            lv_obj_remove_local_style_prop(target, LV_STYLE_BG_OPA, 0);
            break;
        case LVGL_HOST_STYLE_BORDER_COLOR:
            lv_obj_remove_local_style_prop(target, LV_STYLE_BORDER_COLOR, 0);
            break;
        case LVGL_HOST_STYLE_BORDER_WIDTH:
            lv_obj_remove_local_style_prop(target, LV_STYLE_BORDER_WIDTH, 0);
            break;
        case LVGL_HOST_STYLE_BORDER_RADIUS:
            lv_obj_remove_local_style_prop(target, LV_STYLE_RADIUS, 0);
            break;
        case LVGL_HOST_STYLE_PADDING_TOP:
            lv_obj_remove_local_style_prop(target, LV_STYLE_PAD_TOP, 0);
            break;
        case LVGL_HOST_STYLE_PADDING_RIGHT:
            lv_obj_remove_local_style_prop(target, LV_STYLE_PAD_RIGHT, 0);
            break;
        case LVGL_HOST_STYLE_PADDING_BOTTOM:
            lv_obj_remove_local_style_prop(target, LV_STYLE_PAD_BOTTOM, 0);
            break;
        case LVGL_HOST_STYLE_PADDING_LEFT:
            lv_obj_remove_local_style_prop(target, LV_STYLE_PAD_LEFT, 0);
            break;
        case LVGL_HOST_STYLE_COLOR:
            lv_obj_remove_local_style_prop(target, LV_STYLE_TEXT_COLOR, 0);
            break;
        case LVGL_HOST_STYLE_TEXT_ALIGN:
            lv_obj_remove_local_style_prop(target, LV_STYLE_TEXT_ALIGN, 0);
            break;
        default:
            /* Unknown codes are rejected at the binding layer; ignore defensively. */
            break;
    }
}

void lvgl_host_load_screen(lvgl_host_t *host, int id)
{
    if (id == 0) {
        if (host->blank_screen == NULL) host->blank_screen = lv_obj_create(NULL);
        if (host->blank_screen != NULL) {
            lv_screen_load(host->blank_screen);
            lv_refr_now(lv_display_get_default());
        }
        return;
    }
    lvgl_host_entry_t *entry = entry_at(host, id);
    if (entry == NULL || entry->object == NULL) return;
    lv_screen_load(entry->object);
    /* The LVGL timer task normally services this deferred screen load. The
     * runtime swaps roots inside a single owner-task transaction, so force the
     * first frame while the caller still owns the LVGL lock. */
    lv_refr_now(lv_display_get_default());
    if (host->blank_screen != NULL) {
        lv_obj_delete(host->blank_screen);
        host->blank_screen = NULL;
    }
}
