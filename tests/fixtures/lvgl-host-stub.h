#pragma once

/* Minimal LVGL surface used only for generated-C syntax checks. */
typedef struct lv_obj_t lv_obj_t;
typedef struct lv_event_t lv_event_t;
typedef void (*lv_event_cb_t)(lv_event_t *event);

lv_obj_t *lv_screen_active(void);
lv_obj_t *lv_obj_create(lv_obj_t *parent);
lv_obj_t *lv_label_create(lv_obj_t *parent);
void lv_label_set_text(lv_obj_t *label, const char *text);
lv_obj_t *lv_button_create(lv_obj_t *parent);
void lv_obj_set_flex_flow(lv_obj_t *obj, int flow);
void lv_obj_set_flex_align(lv_obj_t *obj, int main_place, int cross_place, int track_place);
void lv_obj_center(lv_obj_t *obj);
void *lv_event_get_user_data(lv_event_t *event);
void lv_obj_add_event_cb(lv_obj_t *obj, lv_event_cb_t event_cb, int filter, void *user_data);

#define LV_EVENT_CLICKED 1
#define LV_FLEX_FLOW_COLUMN 1
#define LV_FLEX_ALIGN_CENTER 1
