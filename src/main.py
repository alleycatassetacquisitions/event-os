from src.notifiers.bounty_device_notifier import BountyDeviceNotifier
import schedule
import time

def main():
    notifier = BountyDeviceNotifier()
    schedule.every(1).minutes.do(notifier.notify_devices)  # Run every 1 minute

    while True:
        schedule.run_pending()
        time.sleep(1)

if __name__ == "__main__":
    main()