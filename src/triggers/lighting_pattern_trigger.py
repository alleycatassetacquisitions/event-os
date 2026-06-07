import datetime

class LightingPatternTrigger:
    def __init__(self):
        self.day_start_hour = 6
        self.day_end_hour = 18

    def should_switch_to_day_pattern(self):
        current_hour = datetime.datetime.now().hour
        return self.day_start_hour <= current_hour < self.day_end_hour

    def should_switch_to_night_pattern(self):
        current_hour = datetime.datetime.now().hour
        return current_hour < self.day_start_hour or current_hour >= self.day_end_hour