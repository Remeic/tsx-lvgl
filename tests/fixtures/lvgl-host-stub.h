#pragma once

/* Minimal LVGL surface used only for generated-C syntax checks. */
#include <stddef.h>
#include <stdint.h>

typedef struct lv_obj_t lv_obj_t;
typedef struct lv_event_t lv_event_t;
typedef int32_t lv_event_code_t;

enum {
  LV_EVENT_CLICKED = 1,
  LV_FLEX_FLOW_ROW = 0,
  LV_FLEX_FLOW_COLUMN = 1,
  LV_FLEX_ALIGN_START = 0,
  LV_FLEX_ALIGN_CENTER = 1,
  LV_FLEX_ALIGN_END = 2,
};

lv_obj_t *lv_screen_active(void);
lv_obj_t *lv_obj_create(lv_obj_t *parent);
lv_obj_t *lv_label_create(lv_obj_t *parent);
void lv_label_set_text(lv_obj_t *label, const char *text);
void lv_label_set_text_static(lv_obj_t *label, const char *text);
lv_obj_t *lv_button_create(lv_obj_t *parent);
void lv_obj_set_flex_flow(lv_obj_t *obj, int32_t flow);
void lv_obj_set_flex_align(lv_obj_t *obj, int32_t main_place, int32_t cross_place, int32_t track_place);
void lv_obj_set_style_pad_all(lv_obj_t *obj, int32_t value, int32_t selector);
void lv_obj_set_style_pad_row(lv_obj_t *obj, int32_t value, int32_t selector);
void lv_obj_set_style_pad_column(lv_obj_t *obj, int32_t value, int32_t selector);
void lv_obj_add_event_cb(lv_obj_t *obj, void (*callback)(lv_event_t *), lv_event_code_t filter, void *user_data);
lv_event_code_t lv_event_get_code(lv_event_t *event);
void lv_obj_send_event(lv_obj_t *obj, lv_event_code_t event_code, void *param);
