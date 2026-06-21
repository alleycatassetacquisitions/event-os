# PDN firmware — ESP-IDF component registration
# REQUIRES lists every IDF component that main.cpp includes directly.
# led_strip is pulled from the IDF Component Registry via idf_component.yml.

FILE(GLOB_RECURSE app_sources ${CMAKE_SOURCE_DIR}/src/*.c ${CMAKE_SOURCE_DIR}/src/*.cpp)

idf_component_register(
    SRCS ${app_sources}
    INCLUDE_DIRS "."
    REQUIRES
        led_strip
        mqtt
        esp_wifi
        esp_netif
        esp_event
        esp_timer
        nvs_flash
        driver
        esp_system
        freertos
        log
)
