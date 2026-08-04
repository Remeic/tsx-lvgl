#pragma once

/* Minimal LVGL surface used only for generated-C syntax checks. */
typedef struct lv_obj_t lv_obj_t;

lv_obj_t *lv_screen_active(void);
lv_obj_t *lv_obj_create(lv_obj_t *parent);
lv_obj_t *lv_label_create(lv_obj_t *parent);
void lv_label_set_text(lv_obj_t *label, const char *text);
lv_obj_t *lv_button_create(lv_obj_t *parent);
