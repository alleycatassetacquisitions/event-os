from src.triggers.lighting_pattern_trigger import LightingPatternTrigger

class BountyDeviceNotifier:
    def __init__(self):
        self.trigger = LightingPatternTrigger()

    def notify_devices(self):
        if self.trigger.should_switch_to_day_pattern():
            # Send notification to switch to day lighting pattern
            print("Switching to day lighting pattern")
        elif self.trigger.should_switch_to_night_pattern():
            # Send notification to switch to night lighting pattern
            print("Switching to night lighting pattern")