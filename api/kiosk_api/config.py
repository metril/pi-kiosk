from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    papyrus_url: str = "http://papyrus:8000"
    papyrus_token: str = ""
    labelmaker_url: str = "http://labelmaker:8000"
    labelmaker_token: str = ""
    idle_minutes: int = 5
    backlight_path: str = "/sys/class/backlight"
    static_dir: str = "/app/static"
    scan_paperless: bool = True
    scan_smb_share_id: str = ""
    scan_smb_path: str = ""
    scan_cloud_provider_id: str = ""
    scan_email_to: str = ""
