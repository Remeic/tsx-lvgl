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
     * Unloaded screen used as a real LVGL parent while a candidate tree is
     * being assembled. LVGL treats objects created with a NULL parent as
     * screens and refuses to reparent them later.
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

    /* lv_obj_delete is recursive. Snapshot only tracked roots and invalidate
     * the table before deleting anything, otherwise a later child entry would
     * be a dangling pointer after its tracked parent had already deleted it. */
    lv_obj_t *roots[LVGL_HOST_MAX_HANDLES];
    uint32_t root_count = 0;
    for (uint32_t index = 0; index < LVGL_HOST_MAX_HANDLES; index++) {
        lvgl_host_entry_t *entry = &host->entries[index];
        if (entry->used && entry->object != NULL && entry->parent_id == 0 && root_count < LVGL_HOST_MAX_HANDLES) {
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

static lv_obj_t *staging_parent(lvgl_host_t *host)
{
    if (host->staging_screen == NULL) host->staging_screen = lv_obj_create(NULL);
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
     * The reconciler creates an object before the parent is known. Keep the
     * root Screen as the only true LVGL screen; stage every other widget
     * under a real, unloaded screen so the following `insert` can safely
     * reparent it. A Button's inner label is a private LVGL child, never
     * exposed as its own handle.
     */
    lv_obj_t *object = NULL;
    lv_obj_t *label = NULL;
    lv_obj_t *staging = NULL;
    switch (kind) {
        case LVGL_HOST_WIDGET_SCREEN:
            object = lv_obj_create(NULL);
            break;
        case LVGL_HOST_WIDGET_VIEW:
            staging = staging_parent(host);
            if (staging != NULL) object = lv_obj_create(staging);
            break;
        case LVGL_HOST_WIDGET_TEXT:
            staging = staging_parent(host);
            if (staging != NULL) {
                object = lv_label_create(staging);
                label = object;
            }
            break;
        case LVGL_HOST_WIDGET_BUTTON:
            staging = staging_parent(host);
            if (staging != NULL) object = lv_button_create(staging);
            if (object != NULL) label = lv_label_create(object);
            if (object == NULL || label == NULL) {
                if (object != NULL) lv_obj_delete(object);
                return 0;
            }
            lv_obj_center(label);
            break;
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
