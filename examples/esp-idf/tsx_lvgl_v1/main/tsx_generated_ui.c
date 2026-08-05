#include "lvgl.h"

static void tsx_lvgl_action_touch_probe(lv_event_t *event)
{
    lv_obj_t *label = lv_event_get_user_data(event);
    lv_label_set_text(label, "Touched");
}

void tsx_lvgl_ui_create(void)
{
    lv_obj_t *root = lv_screen_active();
    lv_obj_set_flex_flow(root, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(root, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_t *root_0 = lv_label_create(root);
    lv_label_set_text(root_0, "TSX-LVGL V1");
    lv_obj_t *root_1 = lv_label_create(root);
    lv_label_set_text(root_1, "SH8601 / FT3168");
    lv_obj_t *root_2 = lv_button_create(root);
    lv_obj_t *root_2_label = lv_label_create(root_2);
    lv_label_set_text(root_2_label, "Touch me");
    lv_obj_center(root_2_label);
    lv_obj_add_event_cb(root_2, tsx_lvgl_action_touch_probe, LV_EVENT_CLICKED, root_2_label);
}
