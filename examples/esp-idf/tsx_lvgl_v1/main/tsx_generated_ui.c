#include "lvgl.h"

void tsx_lvgl_ui_create(void)
{
    lv_obj_t *root = lv_screen_active();
    lv_obj_t *root_0 = lv_label_create(root);
    lv_label_set_text(root_0, "TSX-LVGL V1");
    lv_obj_t *root_1 = lv_label_create(root);
    lv_label_set_text(root_1, "SH8601 / FT3168");
    lv_obj_t *root_2 = lv_button_create(root);
    lv_obj_t *root_2_label = lv_label_create(root_2);
    lv_label_set_text(root_2_label, "Touch me");
    /* TSX-LVGL action: touch_probe */
}
